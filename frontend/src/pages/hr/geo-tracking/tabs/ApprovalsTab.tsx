// Geo Attendance -> On-Duty Approvals: the destination requests (no photos at this stage: those are checked per punch on the Punch
// Verifications tab). Each request is one card: who, where to, how far it got through the approval pipeline, and the decision.
// What HR may decide follows the approval pipeline (User Management -> Approval Workflow Control), not the status label.
import { useState, type ReactNode } from "react";
import { CalendarClock, Camera, CheckCircle2, Clock, ClockArrowUp, MapPin, MapPinned, ShieldAlert, XCircle } from "lucide-react";
import { PipelineNote, WaitingChip } from "@/components/ApprovalTrail";
import { DateRangeBar, OutsideRangeNote, useDateRange } from "@/components/date-range";
import { EmptyNote } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import { explainsWaiting, hrCanAct, hrCanReject, waitingText } from "@/lib/approval-workflow";
import {
  useOnDutySessionsHR,
  useUpdateOnDutySessionHR,
  type OnDutyOtPunchItem,
  type OnDutySessionItem,
} from "@/lib/api-client/custom-hooks";
import PunchPhotosDialog, { type PhotoPunch } from "../PunchPhotos";
import { chooseDays, dayInRange, earliestDay, istDayOf } from "@/lib/date-range";
import DecisionDialog from "../DecisionDialog";
import { fmtDateTime } from "../logic";
import { CardSkeleton, CountText, Eyebrow, LoadError, Note, PersonCell, SessionChip, ToolbarCard } from "../kit";

type Filter = "pending" | "active" | "completed" | "rejected";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
];

const EMPTY_HINT: Record<Filter, string> = {
  pending:
    "Nothing waits for you. New On-Duty requests from employees appear here for a decision. The sidebar shows a badge when one arrives.",
  active: "Approved requests that employees are working under now appear here.",
  completed: "Requests whose duty was marked Done, or ended with the 4th punch, appear here.",
  rejected: "Requests that were turned down appear here.",
};

/** "1 h 20 min" / "45 min". */
function minutesText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const OT_STATUS: Record<OnDutyOtPunchItem["status"], { label: string; className: string }> = {
  pending: { label: "Waits for this request", className: "bg-amber-50 text-amber-800" },
  approved: { label: "Approved", className: "bg-green-50 text-green-700" },
  rejected: { label: "Rejected", className: "bg-red-50 text-red-700" },
};

/**
 * The overtime punches of a session (mobile "Continue Duty" after the four, 2026-11-24): time, place accuracy, photos.
 * They never become attendance; they follow this request's decision, and once approved the last one is the day's OT end
 * for overtime detection (Compensation -> Overtime).
 */
function OvertimePunches({ session }: { session: OnDutySessionItem }) {
  const [open, setOpen] = useState<PhotoPunch | null>(null);
  const punches = session.otPunches ?? [];
  if (!punches.length) return null;
  const minutes = session.otMinutes ?? 0;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40 px-3 py-2.5" data-testid="ot-punches">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>
          <span className="inline-flex items-center gap-1">
            <ClockArrowUp size={12} className="text-amber-700" /> Overtime punches ({punches.length})
          </span>
        </Eyebrow>
        {minutes > 0 && (
          <span className="text-[11px] font-semibold text-amber-800">{minutesText(minutes)} past the shift end</span>
        )}
      </div>
      <ul className="mt-1.5 divide-y divide-amber-100">
        {punches.map((p) => {
          const tone = OT_STATUS[p.status] ?? OT_STATUS.pending;
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs" data-testid="ot-punch">
              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-bold text-amber-800">OT {p.sequence}</span>
              <span className="font-semibold text-gray-900">{p.punchTime.slice(0, 5)}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone.className}`}>{tone.label}</span>
              {p.isMocked && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">Mock location</span>}
              {p.accuracyM != null && <span className="text-gray-500">±{Math.round(p.accuracyM)} m</span>}
              <a
                className="text-[#006496] underline-offset-2 hover:underline"
                href={`https://www.google.com/maps?q=${p.latitude},${p.longitude}`}
                target="_blank"
                rel="noreferrer"
              >
                Map
              </a>
              {(p.hasPhoto || p.hasPhoto2) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto h-7 gap-1 text-[11px]"
                  onClick={() =>
                    setOpen({
                      id: p.id,
                      hasPhoto: p.hasPhoto,
                      hasPhoto2: p.hasPhoto2,
                      employeeName: session.employeeName,
                      punchNumber: p.sequence,
                      punchType: "OUT",
                      punchTime: p.punchTime,
                      photoBase: "on-duty-overtime-punches",
                      description: `${session.employeeName}, OT punch ${p.sequence} at ${p.punchTime.slice(0, 5)}`,
                    })
                  }
                >
                  <Camera size={12} /> Photos
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[11px] leading-snug text-gray-500">
        Not attendance: these follow this request&rsquo;s decision; once approved, the last one counts as the day&rsquo;s
        overtime end.
      </p>
      <PunchPhotosDialog verification={open} onClose={() => setOpen(null)} />
    </div>
  );
}

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
              <WaitingChip approval={approval} className="rounded-full text-[11px] sm:text-[10px]" />
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
                <CalendarClock size={11} /> Submitted {fmtDateTime(session.createdAt)}
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

          <OvertimePunches session={session} />

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
                className="h-9 flex-1 gap-1.5 bg-green-600 bg-none text-xs hover:bg-green-700 lg:flex-none"
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
  // the HR portal's date filter (This Month by default): a request is for the day it was made (a session never runs past
  // its day), and the server sends only those days' requests
  const dates = useDateRange();
  const { data: sessions, isLoading, isError, error, refetch } = useOnDutySessionsHR(statusFilter, true, dates.days);
  // every pending request whatever its day (the tab badge's own list): the ones on other days are named under the toolbar
  const { data: allPending } = useOnDutySessionsHR("pending", statusFilter === "pending");
  const updateMutation = useUpdateOnDutySessionHR();
  const rows = sessions ?? [];
  const outside =
    statusFilter === "pending" ? (allPending ?? []).filter((s) => !dayInRange(istDayOf(s.createdAt), dates.days)) : [];
  const outsideEarliest = earliestDay(outside.map((s) => istDayOf(s.createdAt)));
  // the decision HR clicked, waiting for its confirmation
  const [asking, setAsking] = useState<{ session: OnDutySessionItem; status: "approved" | "rejected" } | null>(null);

  const handleDecision = async (session: OnDutySessionItem, status: "approved" | "rejected", comment?: string) => {
    try {
      const result = await updateMutation.mutateAsync({ id: session.id, status, comment });
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
        description:
          (err as { data?: { error?: string } })?.data?.error ?? (err instanceof Error ? err.message : undefined),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4" data-testid="tab-approvals">
      <PipelineNote workflow="on_duty" />
      <ToolbarCard>
        {/* one row of status pills that scrolls sideways on a phone */}
        <div className="flex min-w-0 max-w-full max-sm:overflow-x-auto" data-tab-row>
          <PillTabs items={FILTERS} value={statusFilter} onChange={(v) => setStatusFilter(v as Filter)} size="sm" />
        </div>
        <DateRangeBar value={dates.value} onChange={dates.set} accent="#006496" testId="approvals-dates" />
        {!isLoading && (
          <CountText testId="approvals-count">
            {rows.length} {statusFilter} request{rows.length === 1 ? "" : "s"} · {dates.label}
          </CountText>
        )}
      </ToolbarCard>
      <OutsideRangeNote
        count={outside.length}
        what={outside.length === 1 ? "pending request" : "pending requests"}
        rangeLabel={dates.label}
        earliest={outsideEarliest && outsideEarliest < dates.days.from ? outsideEarliest : undefined}
        onShow={() => dates.set(chooseDays(outsideEarliest, dates.today))}
        testId="approvals-outside"
      />

      {isLoading ? (
        <CardSkeleton />
      ) : isError && rows.length === 0 ? (
        <LoadError
          title="The On-Duty requests could not be loaded."
          error={error}
          onRetry={() => void refetch()}
          testId="approvals-error"
        />
      ) : rows.length === 0 ? (
        <EmptyNote
          icon={MapPinned}
          title={`No ${statusFilter} On-Duty sessions for ${dates.label}.`}
          hint={EMPTY_HINT[statusFilter]}
        />
      ) : (
        <div className="grid gap-3">
          {rows.map((session, i) => (
            <div
              key={session.id}
              className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300 motion-reduce:animate-none"
              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
            >
              <SessionCard
                session={session}
                busy={updateMutation.isPending}
                onDecide={(s, status) => setAsking({ session: s, status })}
              />
            </div>
          ))}
        </div>
      )}

      <DecisionDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        tone={asking?.status === "rejected" ? "reject" : "approve"}
        title={asking?.status === "rejected" ? "Reject this On-Duty request?" : "Approve this On-Duty request?"}
        confirmLabel={asking?.status === "rejected" ? "Reject request" : "Approve request"}
        withComment
        requireComment={asking?.status === "rejected"}
        description={asking ? <DecisionText session={asking.session} status={asking.status} /> : null}
        onConfirm={(comment) => {
          if (asking) void handleDecision(asking.session, asking.status, comment);
          setAsking(null);
        }}
        testId="approval-confirm"
      />
    </div>
  );
}

/** What a decision on a request does, said before it is sent. */
function DecisionText({ session, status }: { session: OnDutySessionItem; status: "approved" | "rejected" }) {
  const punches = session.pendingPunchCount;
  const who = (
    <b className="text-gray-900">
      {session.employeeName} ({session.employeeCode})
    </b>
  );
  if (status === "rejected") {
    return (
      <>
        <p>
          {who}&rsquo;s request to work at &ldquo;{session.destination}&rdquo; is turned down and their location
          tracking for it stops. Everything recorded until now is kept in Journey History.
        </p>
        {punches > 0 && (
          <p className="font-medium text-red-700">
            The {punches} punch{punches === 1 ? "" : "es"} recorded under it {punches === 1 ? "is" : "are"} voided and
            never reach attendance.
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <p>
        {who} may work at &ldquo;{session.destination}&rdquo;
        {session.approval && session.approval.waitingFor.length > 1 ? " once the remaining approval is given" : ""}.
      </p>
      {punches > 0 && (
        <p>
          The {punches} punch{punches === 1 ? "" : "es"} recorded under it then wait{punches === 1 ? "s" : ""} for your
          check on Punch Verifications.
        </p>
      )}
    </>
  );
}
