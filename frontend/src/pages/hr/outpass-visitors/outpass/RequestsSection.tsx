import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Inbox, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  useListOutpassRequests,
  getListOutpassRequestsQueryKey,
  useUpdateOutpassRequestStatus,
  type OutpassRequestItem,
} from "@/lib/api-client/custom-hooks";
import { PipelineNote, WaitingChip } from "@/components/ApprovalTrail";
import { explainsWaiting, hrCanAct, hrCanReject, trailLine, waitingText } from "@/lib/approval-workflow";
import { DataTable, PersonCell, StatusChip, WhenCell, fmtCount, type DataColumn } from "../kit";

const PAGE_SIZE = 10;

/** The server sends these too (OutpassRequestItem leaves them out). */
type RequestRow = OutpassRequestItem & { passType?: string | null; expectedReturnAt?: string | null };

const PASS_TYPE: Record<string, string> = {
  official: "Official",
  personal: "Personal",
  early_dismissal: "Early dismissal",
};

/**
 * Requests: the gate passes asked for in the Mobile App / Employee Web App that wait for a decision, oldest wait first in
 * the order the server gives. HR decides only what the approval pipeline gives it (User Management -> Approval Workflow
 * Control): hrCanAct / hrCanReject decide whether Approve / Reject are drawn at all, and they also keep the MD portal's
 * view-only copy of this page from deciding anything. A View-only role sees the buttons locked (the page-wide lock).
 */
export function OutpassRequestsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const { data: requests, isLoading, error, refetch } = useListOutpassRequests("pending");
  const updateStatus = useUpdateOutpassRequestStatus();
  const pending: RequestRow[] = requests ?? [];
  const pageCount = Math.max(1, Math.ceil(pending.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageItems = pending.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  // What HR may decide follows the approval pipeline; an older backend sends none and HR then decides any pending
  // request, as it always did.
  const hrDecides = (r: OutpassRequestItem) => hrCanAct(r.approval, true);
  const hrRejects = (r: OutpassRequestItem) => hrCanReject(r.approval, true);
  const forHr = pending.filter(hrDecides).length;

  const act = async (r: OutpassRequestItem, status: "approved" | "rejected") => {
    try {
      await updateStatus.mutateAsync({ id: r.id, data: { status } });
      toast({ title: status === "approved" ? "Gate pass approved" : "Gate pass rejected" });
      queryClient.invalidateQueries({ queryKey: getListOutpassRequestsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListOutpassRequestsQueryKey("pending") });
    } catch (err) {
      toast({
        title: "Could not update the request",
        description: err instanceof Error ? err.message : "Try again in a minute.",
        variant: "destructive",
      });
    }
  };

  const columns: DataColumn<RequestRow>[] = [
    {
      key: "employee",
      header: "Employee",
      cell: (r) => (
        <PersonCell
          name={r.employee?.name ?? `#${r.employeeId}`}
          code={r.employee?.employeeCode}
          sub={r.employee?.department}
          photoUrl={r.employee?.photoUrl}
        />
      ),
      text: (r) => r.employee?.name,
      minWidth: 200,
      maxWidth: 280,
    },
    {
      key: "destination",
      header: "Destination and reason",
      cell: (r) => (
        <span>
          <span className="font-medium text-slate-900">{r.destination}</span>
          {r.reason && r.reason.trim() !== r.destination.trim() && (
            <span className="text-slate-500"> · {r.reason}</span>
          )}
        </span>
      ),
      text: (r) => [r.destination, r.reason].filter(Boolean).join(" · "),
      maxWidth: 300,
    },
    {
      key: "type",
      header: "Pass type",
      cell: (r) => (r.passType ? (PASS_TYPE[r.passType] ?? r.passType) : "—"),
      hideOnPhone: true,
    },
    { key: "asked", header: "Asked", cell: (r) => <WhenCell value={r.createdAt} /> },
    {
      key: "approval",
      header: "Approval",
      cell: (r) =>
        explainsWaiting(r.approval) ? (
          <WaitingChip approval={r.approval} className="text-[11px]" />
        ) : (
          <StatusChip tone="indigo">{waitingText(r.approval) ?? "Waiting"}</StatusChip>
        ),
      text: (r) => trailLine(r.approval),
      truncate: false,
    },
    {
      key: "actions",
      header: <span className="sr-only">Decision</span>,
      align: "right",
      truncate: false,
      cell: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          {hrDecides(r) && (
            <Button
              size="sm"
              variant="outline"
              className="h-11 gap-1 border-teal-200 text-teal-700 hover:bg-teal-50 sm:h-8"
              onClick={() => act(r, "approved")}
              disabled={updateStatus.isPending}
            >
              <CheckCircle2 size={14} /> Approve
            </Button>
          )}
          {hrRejects(r) && (
            <Button
              size="sm"
              variant="outline"
              className="h-11 gap-1 border-rose-200 text-rose-700 hover:bg-rose-50 sm:h-8"
              onClick={() => act(r, "rejected")}
              disabled={updateStatus.isPending}
            >
              <XCircle size={14} /> Reject
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-2" data-testid="outpass-requests">
      <PipelineNote workflow="outpass" className="px-1" />
      <DataTable
        columns={columns}
        rows={requests ? pageItems : undefined}
        rowKey={(r) => r.id}
        loading={isLoading}
        skeletonRows={4}
        error={error ? "The requests could not be loaded. Your role may not include the Requests module." : null}
        onRetry={() => void refetch()}
        summary={
          requests ? (
            <span>
              <strong className="font-semibold text-slate-900">{fmtCount(pending.length)} waiting</strong>
              {pending.length > 0 && ` · ${fmtCount(forHr)} for HR to decide`}
              <span className="text-slate-500"> · asked for in the Mobile App or the Employee Web App</span>
            </span>
          ) : null
        }
        empty={{ icon: Inbox, title: "No gate pass is waiting for a decision", hint: "New requests show up here." }}
        pagination={{ page: pageSafe, pageSize: PAGE_SIZE, total: pending.length, onPageChange: setPage }}
        caption="Gate pass requests waiting for a decision"
        testId="outpass-requests-table"
      />
    </div>
  );
}
