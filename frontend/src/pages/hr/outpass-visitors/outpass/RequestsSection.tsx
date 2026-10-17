import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  useListOutpassRequests,
  getListOutpassRequestsQueryKey,
  useUpdateOutpassRequestStatus,
  type OutpassRequestItem,
} from "@/lib/api-client/custom-hooks";
import { ApprovalTrailLine, PipelineNote, WaitingChip } from "@/components/ApprovalTrail";
import { explainsWaiting, hrCanAct, hrCanReject } from "@/lib/approval-workflow";
import { CheckCircle2, Inbox, XCircle } from "lucide-react";
import { RecordsPagination, fmtDateTime } from "../shared";

// ── Pending Outpass Requests (approve/reject, right here in the Outpass
//    section) -there's no notification/sidebar popup anywhere else in the
//    HRMS for a submitted Outpass request today, so this subtab (Outpass > Requests) is the
//    dedicated place to see and act on them without leaving this page.
//    Same hooks/endpoint as ApprovedPassesSection and the general
//    Requests page (ApprovedRequests.tsx) -just filtered to pending and
//    laid out for acting on rather than auditing. ─────────────────────────

const REQUESTS_PAGE_SIZE = 5;

export function OutpassRequestsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const { data: requests, isLoading } = useListOutpassRequests("pending");
  const updateStatus = useUpdateOutpassRequestStatus();
  const pending: OutpassRequestItem[] = requests ?? [];
  // Client-side paging -this endpoint also serves the Mobile/Web apps' own
  // "my requests" list as a flat array, so it can't switch to a
  // {items,total,page,pageSize} shape without breaking them. A pending
  // queue is small enough that paging the already-fetched list is fine.
  const pageCount = Math.max(1, Math.ceil(pending.length / REQUESTS_PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageItems = pending.slice((pageSafe - 1) * REQUESTS_PAGE_SIZE, pageSafe * REQUESTS_PAGE_SIZE);

  // What HR may decide follows the approval pipeline (User Management -> Approval Workflow Control); an older
  // backend sends none and HR then decides any pending request, as it always did.
  const hrDecides = (r: OutpassRequestItem) => hrCanAct(r.approval, true);
  const hrRejects = (r: OutpassRequestItem) => hrCanReject(r.approval, true);

  const act = async (id: number, status: "approved" | "rejected") => {
    try {
      await updateStatus.mutateAsync({ id, data: { status } });
      toast({ title: status === "approved" ? "Outpass approved" : "Outpass rejected" });
      queryClient.invalidateQueries({ queryKey: getListOutpassRequestsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListOutpassRequestsQueryKey("pending") });
    } catch (err) {
      toast({
        title: "Failed to update the request",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Card data-testid="outpass-requests">
      <CardContent className="p-0">
        <div className="px-4 pt-4 pb-2">
          <p className="font-bold text-sm">Pending Outpass Requests</p>
          <p className="text-xs text-muted-foreground">Submitted from the Mobile App / Employee Web App.</p>
          <PipelineNote workflow="outpass" className="mt-1" />
        </div>
        <div className="divide-y">
          {isLoading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
          ) : !pending.length ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
              <Inbox size={22} className="opacity-40" />
              <p className="text-sm">No pending outpass requests.</p>
            </div>
          ) : (
            pageItems.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Avatar className="size-9 shrink-0">
                  <AvatarImage src={r.employee?.photoUrl ?? undefined} />
                  <AvatarFallback className="text-xs">{r.employee?.name?.[0] ?? "?"}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {r.employee?.name ?? `#${r.employeeId}`}
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      {r.employee?.employeeCode}
                      {r.employee?.department && ` · ${r.employee.department}`}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.destination} · {r.reason}
                  </p>
                  <p className="text-[11px] text-muted-foreground/70">{fmtDateTime(r.createdAt)}</p>
                  <ApprovalTrailLine approval={r.approval} className="mt-0.5" />
                </div>
                {explainsWaiting(r.approval) && <WaitingChip approval={r.approval} className="shrink-0" />}
                <div className="flex shrink-0 items-center gap-1.5">
                  {hrDecides(r) && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1 border-green-200 text-green-700 hover:bg-green-50"
                      onClick={() => act(r.id, "approved")}
                      disabled={updateStatus.isPending}
                    >
                      <CheckCircle2 size={14} /> Approve
                    </Button>
                  )}
                  {hrRejects(r) && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1 border-red-200 text-red-600 hover:bg-red-50"
                      onClick={() => act(r.id, "rejected")}
                      disabled={updateStatus.isPending}
                    >
                      <XCircle size={14} /> Reject
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
        {pending.length > 0 && (
          <RecordsPagination
            page={pageSafe}
            total={pending.length}
            pageSize={REQUESTS_PAGE_SIZE}
            onPageChange={setPage}
          />
        )}
      </CardContent>
    </Card>
  );
}
