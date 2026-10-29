// Geo Attendance -> On-Duty Approvals: the destination requests (no photos at this stage: those are checked per punch on the Punch
// Verifications tab). Each request is one card: who, where to, how far it got through the approval pipeline, and the decision.
// What HR may decide follows the approval pipeline (User Management -> Approval Workflow Control), not the status label.
import { useState, type ReactNode } from "react";
import { CalendarClock, CheckCircle2, Clock, MapPin, MapPinned, ShieldAlert, XCircle } from "lucide-react";
import { PipelineNote, WaitingChip } from "@/components/ApprovalTrail";
import { EmptyNote } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import { explainsWaiting, hrCanAct, hrCanReject, waitingText } from "@/lib/approval-workflow";
import { useOnDutySessionsHR, useUpdateOnDutySessionHR, type OnDutySessionItem } from "@/lib/api-client/custom-hooks";
import { fmtDateTime } from "../logic";
import { CountText, Eyebrow, ListSkeleton, Note, PersonCell, SessionChip, ToolbarCard } from "../kit";

type Filter = "pending" | "active" | "completed" | "rejected";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
];

const EMPTY_HINT: Record<Filter, string> = {
  pending: "New On-Duty requests from employees appear here for a decision.",
  active: "Approved requests that employees are working under now appear here.",
  completed: "Requests whose duty was marked Done, or ended with the 4th punch, appear here.",
  rejected: "Requests that were turned down appear here.",
};

/** One line of the review trail: who looked at the request and what they decided. */
function ReviewLine({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-snug text-gray-500">{children}</p>;
}

function SessionCard({
  session,
  busy,
  onDecide,
}: {
  session: OnDutySessionItem;
  busy: boolean;
  onDecide: (session: OnDutySessionItem, status: "approved" | "rejected") => void;
}) {
  const isWaiting = session.status === "pending_hod" || session.status === "pending_hr";
  const canApprove = hrCanAct(session.approval, isWaiting);
  const canReject = hrCanReject(session.approval, isWaiting);
  const approval = session.approval;
  const pending = session.pendingPunchCount;

  return (
    <article
      className="overflow-hidden rounded-2xl border bg-white"
      data-testid="approval-card"
      data-session-id={session.id}
      data-status={session.status}
    >
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <PersonCell
              name={session.employeeName}
              code={session.employeeCode}
              sub={`${session.department ?? "No department"} · ${session.branchName ?? "no branch"}`}
              size={40}
            />
            {explainsWaiting(approval) ? (
              <WaitingChip approval={approval} className="rounded-full" />
            ) : (
              <SessionChip status={session.status} />
            )}
          </div>

          <div className="rounded-xl bg-slate-50 px-3 py-2.5">
            <Eyebrow>Destination</Eyebrow>
            <p className="mt-0.5 flex items-start gap-1.5 text-sm font-medium text-gray-900">
              <MapPin size={14} className="mt-0.5 shrink-0 text-[#006496]" />
              <span className="min-w-0 break-words">{session.destination}</span>
            </p>
            {session.createdAt && (
              <p className="mt-1 flex items-center gap-1 text-[11px] text-gray-500">
                <CalendarClock size={11} /> Requested {fmtDateTime(session.createdAt)}
              </p>
            )}
          </div>

          {(session.hodReviewedBy || session.hrReviewedBy || session.status === "completed") && (
            <div className="space-y-0.5" data-testid="approval-review">
              {session.hodReviewedBy && (
                <ReviewLine>
                  HOD: {session.status === "rejected" && !session.hrReviewedBy ? "rejected" : "approved"} by{" "}
                  <b className="font-semibold text-gray-700">{session.hodReviewedBy}</b>
                  {session.hodReviewComment ? ` - "${session.hodReviewComment}"` : ""}
                </ReviewLine>
              )}
              {session.hrReviewedBy && (
                <ReviewLine>
                  HR: {session.status === "rejected" ? "rejected" : "approved"} by{" "}
                  <b className="font-semibold text-gray-700">{session.hrReviewedBy}</b>
                  {session.hrReviewComment ? ` - "${session.hrReviewComment}"` : ""}
                </ReviewLine>
              )}
              {session.status === "completed" && (
                <ReviewLine>
                  Ended{" "}
                  {session.completionReason === "auto_4th_punch"
                    ? "automatically (4th punch approved)"
                    : "manually by the employee"}
                  {session.completedAt ? ` at ${new Date(session.completedAt).toLocaleString()}` : ""}
                </ReviewLine>
              )}
            </div>
          )}

          {!approval && session.status === "pending_hod" && (
            <Note tone="warn" icon={ShieldAlert}>
              No Department Head has acted yet - approving here finalizes it directly.
            </Note>
          )}
          {approval && approval.currentStep !== null && approval.canAct.hr && approval.waitingFor.includes("hod") && (
            <Note tone="warn" icon={ShieldAlert}>
              The Department Head has not acted yet - approving here decides it directly.
            </Note>
          )}
          {approval && approval.currentStep !== null && !approval.canAct.hr && (
            <Note tone="warn" icon={ShieldAlert}>
              {waitingText(approval)}: HR cannot decide this session until that step is done.
            </Note>
          )}
          {/* The employee is already out working under this request - HR is deciding after the fact, so the stakes of the
              decision have to be on screen before they click. */}
          {session.isProvisional && (
            <Note tone="warn" icon={Clock}>
              <p className="leading-relaxed text-amber-800">
                {session.employeeEndedAt ? (
                  <>
                    The employee <b>worked this session and marked it done</b> at{" "}
                    {new Date(session.employeeEndedAt).toLocaleString()}, without waiting for approval.
                  </>
                ) : (
                  <>
                    The employee is <b>already working under this request</b> - they did not wait for approval.
                  </>
                )}
                {pending > 0 ? (
                  <>
                    {" "}
                    They have recorded{" "}
                    <b>
                      {pending} punch{pending === 1 ? "" : "es"}
                    </b>
                    , held and not yet counted as attendance. Approving makes {pending === 1 ? "it" : "them"} eligible
                    for your punch review; rejecting voids {pending === 1 ? "it" : "them all"} permanently.
                  </>
                ) : (
                  <> No punches recorded under it yet.</>
                )}
              </p>
            </Note>
          )}
        </div>

        {(canApprove || canReject) && (
          <div className="flex items-center gap-2 lg:flex-col lg:items-stretch" data-testid="approval-actions">
            {canApprove && (
              <Button
                size="sm"
                className="h-9 flex-1 gap-1.5 bg-green-600 text-xs hover:bg-green-700 lg:flex-none"
                disabled={busy}
                onClick={() => onDecide(session, "approved")}
              >
                <CheckCircle2 size={13} /> Approve
              </Button>
            )}
            {canReject && (
              <Button
                size="sm"
                variant="destructive"
                className="h-9 flex-1 gap-1.5 text-xs lg:flex-none"
                disabled={busy}
                onClick={() => onDecide(session, "rejected")}
              >
                <XCircle size={13} /> Reject
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default function ApprovalsTab() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<Filter>("pending");
  const { data: sessions, isLoading } = useOnDutySessionsHR(statusFilter);
  const updateMutation = useUpdateOnDutySessionHR();
  const rows = sessions ?? [];

  const handleDecision = async (session: OnDutySessionItem, status: "approved" | "rejected") => {
    try {
      const result = await updateMutation.mutateAsync({ id: session.id, status });
      const passedOn =
        status === "approved" && result != null && (result.status === "pending_hod" || result.status === "pending_hr");
      toast({
        title: passedOn ? "Session approved" : `Session ${status}`,
        description: passedOn
          ? `${waitingText(result.approval) ?? "Waiting for the next approval"} before it is final.`
          : `${session.employeeName}'s On-Duty request for ${session.destination}.`,
      });
    } catch (err: unknown) {
      toast({
        title: "Failed to update session",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4" data-testid="tab-approvals">
      <PipelineNote workflow="on_duty" />
      <ToolbarCard>
        <PillTabs items={FILTERS} value={statusFilter} onChange={(v) => setStatusFilter(v as Filter)} size="sm" />
        {!isLoading && (
          <CountText testId="approvals-count">
            {rows.length} {statusFilter} request{rows.length === 1 ? "" : "s"}
          </CountText>
        )}
      </ToolbarCard>

      {isLoading ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <EmptyNote icon={MapPinned} title={`No ${statusFilter} On-Duty sessions.`} hint={EMPTY_HINT[statusFilter]} />
      ) : (
        <div className="grid gap-3">
          {rows.map((session) => (
            <SessionCard key={session.id} session={session} busy={updateMutation.isPending} onDecide={handleDecision} />
          ))}
        </div>
      )}
    </div>
  );
}
