import { useMemo, useState } from "react";
import { CalendarCheck, CalendarHeart, Hourglass, ListChecks, UserCheck, UserX } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { PipelineNote } from "@/components/ApprovalTrail";
import { RefreshButton } from "@/components/PageRefreshBar";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import { waitingText } from "@/lib/approval-workflow";
import {
  useCreateCasualLeave,
  useDecideCasualLeave,
  useDeleteCasualLeave,
  useListCasualLeaves,
} from "@/lib/api-client/custom-hooks";
import { ConfirmDialog } from "./leave/ConfirmDialog";
import { exportSheet } from "./leave/export";
import { ALL, branchOptions, departmentOptions, longDate, type PersonFilters } from "./leave/logic";
import { MonthPicker, StatCard, useVisibleCount } from "./leave/parts";
import ApplyDialog from "./casual-leave/ApplyDialog";
import ClTab from "./casual-leave/ClTab";
import { useClBoard } from "./casual-leave/api";
import { EligibleList, NotEligibleList, RequestList } from "./casual-leave/lists";
import {
  BOARD_EXPORT_HEADERS,
  NO_CL_FILTERS,
  REQUEST_EXPORT_HEADERS,
  boardExportRows,
  clFiltersActive,
  eligibleRows,
  filterBoard,
  filterRequests,
  isCurrentMonth,
  monthTitle,
  notEligibleRows,
  requestExportRows,
  sortRequests,
  summarize,
  takenRows,
  type BoardRow,
  type ClRequest,
} from "./casual-leave/logic";

type Tab = "taken" | "eligible" | "not-eligible" | "requests";

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function CasualLeave() {
  const { toast } = useToast();
  const today = useMemo(localToday, []);
  const [{ year, month }, setMonth] = useState(() => ({
    year: Number(today.slice(0, 4)),
    month: Number(today.slice(5, 7)),
  }));
  const [tab, setTab] = useState<Tab>("taken");

  // each view keeps its own search and filters
  const [takenF, setTakenF] = useState<PersonFilters>(NO_CL_FILTERS);
  const [eligibleF, setEligibleF] = useState<PersonFilters>(NO_CL_FILTERS);
  const [notF, setNotF] = useState<PersonFilters>(NO_CL_FILTERS);
  const [reqF, setReqF] = useState<PersonFilters>(NO_CL_FILTERS);
  const [takenStatus, setTakenStatus] = useState(ALL);
  const [reqStatus, setReqStatus] = useState(ALL);
  const [reason, setReason] = useState(ALL);
  const takenMore = useVisibleCount();
  const eligibleMore = useVisibleCount();
  const notMore = useVisibleCount();
  const reqMore = useVisibleCount();

  const [applyFor, setApplyFor] = useState<{ employeeId: number; name: string } | null>(null);
  const [applyProblem, setApplyProblem] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ClRequest | null>(null);

  const boardQuery = useClBoard(month, year);
  const requestsQuery = useListCasualLeaves({ month, year });
  const createMutation = useCreateCasualLeave();
  const decideMutation = useDecideCasualLeave();
  const deleteMutation = useDeleteCasualLeave();

  const board = useMemo(() => boardQuery.data?.employees ?? [], [boardQuery.data]);
  const requests = useMemo(() => (requestsQuery.data ?? []) as unknown as ClRequest[], [requestsQuery.data]);
  const summary = useMemo(() => summarize(board, requests), [board, requests]);
  const months = boardQuery.data?.eligibilityMonths ?? 6;
  const label = monthTitle(year, month);
  const current = isCurrentMonth(year, month, today);

  const people = useMemo(() => [...board, ...requests], [board, requests]);
  const branches = useMemo(() => branchOptions(people), [people]);
  const departments = useMemo(() => departmentOptions(people), [people]);

  const retryBoard = () => void boardQuery.refetch();
  const retryRequests = () => void requestsQuery.refetch();

  // ── what each view lists ──
  const taken = useMemo(
    () => filterRequests(takenRows(requests), takenF, takenStatus),
    [requests, takenF, takenStatus],
  );
  const takenAll = useMemo(() => takenRows(requests), [requests]);
  const eligible = useMemo(() => filterBoard(eligibleRows(board), eligibleF), [board, eligibleF]);
  const eligibleAll = useMemo(() => eligibleRows(board), [board]);
  const notAll = useMemo(() => notEligibleRows(board), [board]);
  const notEligible = useMemo(
    () => filterBoard(notAll, notF).filter((r) => reason === ALL || r.reasonCode === reason),
    [notAll, notF, reason],
  );
  const reqAll = useMemo(() => sortRequests(requests), [requests]);
  const reqShown = useMemo(() => filterRequests(reqAll, reqF, reqStatus), [reqAll, reqF, reqStatus]);

  // What HR may decide follows the approval pipeline (User Management -> Approval Workflow Control); the list buttons
  // ask it per request, so this only carries out a decision.
  const decide = async (r: ClRequest, status: "approved" | "rejected") => {
    try {
      const result = await decideMutation.mutateAsync({ id: r.id, status });
      const passedOn = status === "approved" && result != null && result.status === "pending";
      toast({
        title: passedOn ? "Casual leave approved" : `Casual leave ${status}`,
        description: passedOn
          ? `${waitingText(result.approval) ?? "Waiting for the next approval"} before it is final.`
          : status === "approved"
            ? `${r.employeeName}'s attendance for ${r.date} is now marked Present (paid full day).`
            : `${r.employeeName}'s attendance for ${r.date} is marked as Leave.`,
      });
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to update", variant: "destructive" });
    }
  };

  const remove = async (r: ClRequest) => {
    try {
      await deleteMutation.mutateAsync(r.id);
      toast({ title: "Record deleted" });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  };

  const submitOnBehalf = async (input: { employeeId: number; date: string; reason: string }) => {
    if (!applyFor) return;
    setApplyProblem(null);
    try {
      await createMutation.mutateAsync({
        employeeId: input.employeeId,
        date: input.date,
        reason: input.reason || undefined,
      });
      toast({ title: `CL request created for ${applyFor.name}` });
      setApplyFor(null);
    } catch (err: any) {
      // the server's own words ("already used this month", "eligible after 6 months")
      setApplyProblem(err?.data?.error ?? err?.message ?? "Failed to create request");
    }
  };

  const apply = (r: BoardRow) => {
    setApplyProblem(null);
    setApplyFor({ employeeId: r.employeeId, name: r.employeeName ?? r.employeeCode ?? `#${r.employeeId}` });
  };

  const decideProps = {
    busy: decideMutation.isPending || deleteMutation.isPending,
    onDecide: decide,
    onDelete: setToDelete,
  };
  const boardState = { loading: boardQuery.isLoading, failed: boardQuery.isError, onRetry: retryBoard };
  const requestState = { loading: requestsQuery.isLoading, failed: requestsQuery.isError, onRetry: retryRequests };
  const pills = (counts: Record<string, number>, labels: [string, string][]) =>
    labels.map(([value, text]) => ({ value, label: text, count: counts[value] }));

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Casual Leave (CL)</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Paid leave · staff only · 1 per month · eligible after {months} months of service
            </p>
            <PipelineNote workflow="casual_leave" className="mt-1" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RefreshButton />
            <MonthPicker year={year} month={month} onChange={setMonth} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Taken this month"
            value={boardQuery.isLoading && requestsQuery.isLoading ? "…" : summary.taken}
            sub={`approved in ${label}`}
            icon={CalendarCheck}
            tone="bg-emerald-50 text-emerald-800"
            testId="cl-stat-taken"
            onClick={() => setTab("taken")}
            active={tab === "taken"}
          />
          <StatCard
            label="Eligible"
            value={boardQuery.isLoading ? "…" : summary.eligible}
            sub={current ? "can still take CL this month" : `could take CL in ${label}`}
            icon={UserCheck}
            tone="bg-blue-50 text-blue-800"
            testId="cl-stat-eligible"
            onClick={() => setTab("eligible")}
            active={tab === "eligible"}
          />
          <StatCard
            label="Not eligible"
            value={boardQuery.isLoading ? "…" : summary.notEligible}
            sub={`${summary.byReason.not_staff} production · ${summary.byReason.under_service} under ${months} months · ${summary.byReason.used_this_month} used`}
            icon={UserX}
            tone="bg-slate-100 text-slate-700"
            testId="cl-stat-not-eligible"
            onClick={() => setTab("not-eligible")}
            active={tab === "not-eligible"}
          />
          <StatCard
            label="Pending"
            value={requestsQuery.isLoading ? "…" : summary.pending}
            sub={summary.pending ? "waiting for a decision" : "nothing waiting"}
            icon={Hourglass}
            tone="bg-amber-50 text-amber-800"
            testId="cl-stat-pending"
            onClick={() => {
              setReqStatus("pending");
              setTab("requests");
            }}
            active={tab === "requests" && reqStatus === "pending"}
          />
        </div>

        <div>
          <div className="max-w-full overflow-x-auto pb-1">
            <PillTabs
              items={[
                { value: "taken", label: "Taken this month", icon: <CalendarHeart size={14} /> },
                { value: "eligible", label: "Eligible", icon: <UserCheck size={14} /> },
                { value: "not-eligible", label: "Not eligible", icon: <UserX size={14} /> },
                { value: "requests", label: "Requests", icon: <ListChecks size={14} /> },
              ]}
              value={tab}
              onChange={(v) => setTab(v as Tab)}
            />
          </div>

          {tab === "taken" && (
            <ClTab
              id="taken"
              filters={takenF}
              onFilters={setTakenF}
              noFilters={NO_CL_FILTERS}
              branches={branches}
              departments={departments}
              searchLabel="Search who took casual leave"
              pills={{
                items: pills(
                  {
                    all: takenAll.length,
                    approved: takenAll.filter((r) => r.status === "approved").length,
                    pending: takenAll.filter((r) => r.status === "pending").length,
                  },
                  [
                    ["all", "All"],
                    ["approved", "Approved"],
                    ["pending", "Pending"],
                  ],
                ),
                value: takenStatus,
                onChange: setTakenStatus,
              }}
              {...requestState}
              total={takenAll.length}
              shown={taken.length}
              visible={takenMore.count}
              onMore={takenMore.more}
              noun="casual leaves"
              active={clFiltersActive(takenF, [takenStatus])}
              empty={{
                icon: CalendarHeart,
                title: `Nobody has taken casual leave in ${label}`,
                text: current
                  ? "Approved and pending Casual Leave for this month will be listed here, with who approved it."
                  : "No approved or pending Casual Leave was recorded for this month.",
              }}
              onExport={() =>
                exportSheet(`Casual leave taken ${label}`, REQUEST_EXPORT_HEADERS, requestExportRows(taken))
              }
            >
              <RequestList rows={taken.slice(0, takenMore.count)} {...decideProps} />
            </ClTab>
          )}

          {tab === "eligible" && (
            <ClTab
              id="eligible"
              filters={eligibleF}
              onFilters={setEligibleF}
              noFilters={NO_CL_FILTERS}
              branches={branches}
              departments={departments}
              showEmployeeType={false}
              searchLabel="Search eligible employees"
              {...boardState}
              total={eligibleAll.length}
              shown={eligible.length}
              visible={eligibleMore.count}
              onMore={eligibleMore.more}
              noun="eligible employees"
              active={clFiltersActive(eligibleF)}
              empty={{
                icon: UserCheck,
                title: "Nobody is eligible",
                text: `Staff who have completed ${months} months of service and have not used this month's Casual Leave appear here.`,
              }}
              onExport={() =>
                exportSheet(`Casual leave eligible ${label}`, BOARD_EXPORT_HEADERS, boardExportRows(eligible))
              }
            >
              <EligibleList rows={eligible.slice(0, eligibleMore.count)} onApply={apply} monthLabel={label} />
            </ClTab>
          )}

          {tab === "not-eligible" && (
            <ClTab
              id="not-eligible"
              filters={notF}
              onFilters={setNotF}
              noFilters={NO_CL_FILTERS}
              branches={branches}
              departments={departments}
              searchLabel="Search employees who are not eligible"
              pills={{
                items: pills(
                  {
                    all: notAll.length,
                    ...summary.byReason,
                  },
                  [
                    ["all", "All"],
                    ["used_this_month", "Used this month"],
                    ["under_service", `Under ${months} months`],
                    ["not_staff", "Production"],
                    ["no_join_date", "No join date"],
                  ],
                ),
                value: reason,
                onChange: setReason,
              }}
              {...boardState}
              total={notAll.length}
              shown={notEligible.length}
              visible={notMore.count}
              onMore={notMore.more}
              noun="employees"
              active={clFiltersActive(notF, [reason])}
              empty={{
                icon: UserX,
                title: "Everyone is eligible",
                text: "Nobody is held back from Casual Leave this month.",
              }}
              onExport={() =>
                exportSheet(`Casual leave not eligible ${label}`, BOARD_EXPORT_HEADERS, boardExportRows(notEligible))
              }
            >
              <NotEligibleList rows={notEligible.slice(0, notMore.count)} eligibilityMonths={months} />
            </ClTab>
          )}

          {tab === "requests" && (
            <ClTab
              id="requests"
              filters={reqF}
              onFilters={setReqF}
              noFilters={NO_CL_FILTERS}
              branches={branches}
              departments={departments}
              searchLabel="Search casual leave requests"
              pills={{
                items: pills(
                  {
                    all: reqAll.length,
                    pending: summary.pending,
                    approved: summary.taken,
                    rejected: summary.rejected,
                  },
                  [
                    ["all", "All"],
                    ["pending", "Pending"],
                    ["approved", "Approved"],
                    ["rejected", "Rejected"],
                  ],
                ),
                value: reqStatus,
                onChange: setReqStatus,
              }}
              {...requestState}
              total={reqAll.length}
              shown={reqShown.length}
              visible={reqMore.count}
              onMore={reqMore.more}
              noun="requests"
              active={clFiltersActive(reqF, [reqStatus])}
              empty={{
                icon: ListChecks,
                title: `No casual leave requests for ${label}`,
                text: "Requests come from the employee mobile app, or from Apply CL on the Eligible tab.",
              }}
              onExport={() =>
                exportSheet(`Casual leave requests ${label}`, REQUEST_EXPORT_HEADERS, requestExportRows(reqShown))
              }
              note={
                <p className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-700">
                  Requests are submitted from the employee mobile app. The Department Head (on mobile, when "Can approve
                  casual leave" is enabled in User Management) or HR (here) can decide, as the approval pipeline allows.{" "}
                  <strong>Approved</strong> marks that date Present (paid full day); <strong>Rejected</strong> marks it
                  as Leave.
                </p>
              }
            >
              <RequestList rows={reqShown.slice(0, reqMore.count)} {...decideProps} />
            </ClTab>
          )}
        </div>
      </div>

      <ApplyDialog
        target={applyFor}
        year={year}
        month={month}
        today={today}
        saving={createMutation.isPending}
        problem={applyProblem}
        onClose={() => setApplyFor(null)}
        onSubmit={submitOnBehalf}
      />
      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this record?"
        description={
          toDelete
            ? `${toDelete.employeeName}'s ${toDelete.status} Casual Leave for ${longDate(toDelete.date)} will be removed from the list. Attendance already written for that date is not changed.`
            : ""
        }
        confirmLabel="Delete"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void remove(toDelete);
          setToDelete(null);
        }}
        testId="confirm-delete-cl"
      />
    </HrLayout>
  );
}
