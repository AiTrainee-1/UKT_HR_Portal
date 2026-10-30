import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, CheckCircle2, ClipboardCheck, Hourglass, Loader2, ShieldCheck, XCircle } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { ApprovalTrail, WaitingChip } from "@/components/ApprovalTrail";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  useAttendanceOverrideRequests,
  useDecideAttendanceEdit,
  type AttendanceOverrideRequest,
} from "@/lib/api-client/custom-hooks";
import { hrCanAct, hrCanReject } from "@/lib/approval-workflow";
import { cn } from "@/lib/utils";

type Tab = "hr" | "hod" | "approved" | "rejected";

const STATUS_LABEL: Record<string, string> = {
  present: "Present",
  half_shift: "Half Day",
  absent: "Absent",
  on_leave: "On Leave",
  holiday: "Holiday",
};

function Row({ req, canDecide }: { req: AttendanceOverrideRequest; canDecide: boolean }) {
  const { toast } = useToast();
  const decide = useDecideAttendanceEdit();
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState(false);
  const want = req.requestedValues;
  const was = req.previousValues;
  const mayApprove = canDecide && hrCanAct(req.approval, false);
  const mayReject = canDecide && hrCanReject(req.approval, false);

  const act = async (status: "approved" | "rejected") => {
    try {
      await decide.mutateAsync({ id: req.id, status, comment: comment.trim() || undefined });
      toast({
        title:
          status === "approved" ? "Approved: the attendance has been updated" : "Rejected: the attendance is unchanged",
        description: `${req.employeeName} · ${req.date}`,
      });
    } catch (e) {
      toast({
        title: "Could not save",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="rounded-2xl" data-testid={`edit-request-${req.id}`}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-bold text-gray-900">
              {req.employeeName} <span className="font-mono text-xs font-normal text-gray-500">{req.employeeCode}</span>
            </p>
            <p className="text-xs text-gray-500">
              {req.department ?? ""} · <span className="font-mono">{req.date}</span>
            </p>
          </div>
          <WaitingChip approval={req.approval} />
          {req.status === "approved" && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700">
              <CheckCircle2 size={13} /> Approved by both
            </span>
          )}
          {req.status === "rejected" && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700">
              <XCircle size={13} /> Rejected
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl bg-slate-50 px-3 py-2 text-xs text-gray-700">
          <span>
            <span className="text-gray-400">Was </span>
            <strong>{STATUS_LABEL[was?.status ?? ""] ?? was?.status ?? "—"}</strong> ·{" "}
            {Number(was?.shiftsEarned ?? 0).toFixed(2)} shift
          </span>
          <span className="text-gray-300">→</span>
          <span>
            <span className="text-gray-400">Proposed </span>
            <strong data-testid={`edit-request-type-${req.id}`}>
              {req.typeLabel ?? STATUS_LABEL[want?.status ?? ""] ?? "—"}
            </strong>{" "}
            · {Number(want?.shiftsEarned ?? 0).toFixed(2)} shift
          </span>
          {(want?.firstPunch || want?.lastPunch) && (
            <span className="font-mono">
              {want?.firstPunch ?? "—"} to {want?.lastPunch ?? "—"}
            </span>
          )}
          {want?.isLate && <span className="font-semibold text-red-600">Late</span>}
          {want?.isEarlyOut && <span className="font-semibold text-red-600">Early out</span>}
        </div>

        <p className="text-xs text-gray-600">
          <span className="text-gray-400">Reason: </span>
          {req.reason || "—"} <span className="text-gray-400">· proposed by {req.requestedBy ?? "HR"}</span>
        </p>

        {req.approval && <ApprovalTrail approval={req.approval} submittedBy="HR" />}
        {req.reviewComment && <p className="text-xs text-gray-500">Note: {req.reviewComment}</p>}

        {(mayApprove || mayReject) && (
          <div className="space-y-2 border-t pt-3">
            {open && (
              <Textarea
                rows={2}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="A note for the record (optional)"
                data-testid={`edit-request-comment-${req.id}`}
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {mayApprove && (
                <Button
                  size="sm"
                  className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                  disabled={decide.isPending}
                  onClick={() => act("approved")}
                  data-testid={`edit-request-approve-${req.id}`}
                >
                  {decide.isPending ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                  Approve (second approval)
                </Button>
              )}
              {mayReject && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 border-red-200 text-red-700 hover:bg-red-50"
                  disabled={decide.isPending}
                  onClick={() => act("rejected")}
                  data-testid={`edit-request-reject-${req.id}`}
                >
                  <XCircle size={13} /> Reject
                </Button>
              )}
              {!open && (
                <button
                  type="button"
                  className="text-xs font-semibold text-indigo-700 hover:underline"
                  onClick={() => setOpen(true)}
                >
                  Add a note
                </button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Attendance edit requests. HR's second approval: an edit reaches this list only after the employee's Department Head has
 * approved it, and approving it here is what changes the attendance record. "Waiting for the Department Head" shows what has
 * not reached HR yet (HR cannot decide those); the Approved and Rejected tabs are the record.
 */
export default function AttendanceEditRequests() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>("hr");
  const hr = useAttendanceOverrideRequests({ waiting: "hr" });
  const hod = useAttendanceOverrideRequests({ waiting: "hod" });
  const approved = useAttendanceOverrideRequests({ status: "approved" });
  const rejected = useAttendanceOverrideRequests({ status: "rejected" });
  const query = { hr, hod, approved, rejected }[tab];
  const items = query.data ?? [];
  const counts = { hr: hr.data?.length, hod: hod.data?.length };

  return (
    <HrLayout>
      <div className="mx-auto max-w-4xl space-y-5 pb-10" data-testid="attendance-edit-requests-page">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/hr/attendance/staff")}
            aria-label="Back to Attendance"
          >
            <ArrowLeft size={18} />
          </Button>
          <div className="rounded-2xl bg-indigo-600 p-2.5 text-white shadow-sm">
            <ClipboardCheck size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-black text-gray-900">Attendance Edit Requests</h2>
            <p className="text-sm text-muted-foreground">
              Every attendance change needs the Department Head first, then HR. HR&apos;s approval below is the second
              one.
            </p>
          </div>
        </div>

        <PillTabs
          items={[
            { value: "hr", label: `Waiting for HR${counts.hr ? ` (${counts.hr})` : ""}` },
            { value: "hod", label: `Waiting for the Department Head${counts.hod ? ` (${counts.hod})` : ""}` },
            { value: "approved", label: "Approved" },
            { value: "rejected", label: "Rejected" },
          ]}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
        />

        {query.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-36 rounded-2xl" />
            <Skeleton className="h-36 rounded-2xl" />
          </div>
        ) : query.isError ? (
          <Card className="rounded-2xl ring-1 ring-red-200">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-red-700">
              <span>The requests could not be loaded: {(query.error as Error)?.message ?? "no answer"}.</span>
              <Button size="sm" variant="outline" onClick={() => query.refetch()}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : items.length === 0 ? (
          <Card className="rounded-2xl">
            <CardContent
              className="flex flex-col items-center gap-2 p-10 text-center text-sm text-gray-500"
              data-testid="edit-requests-empty"
            >
              <Hourglass size={26} className="text-gray-300" />
              {tab === "hr"
                ? "Nothing is waiting for HR. A change appears here once the Department Head has approved it."
                : tab === "hod"
                  ? "Nothing is waiting for a Department Head."
                  : "Nothing here yet."}
              <p className="text-xs text-gray-400">
                Start one from the pencil on a day in{" "}
                <Link href="/hr/attendance/staff" className="font-semibold text-indigo-700 underline">
                  Attendance
                </Link>
                .
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className={cn("space-y-3")}>
            {items.map((r) => (
              <Row key={r.id} req={r} canDecide={tab === "hr"} />
            ))}
          </div>
        )}
      </div>
    </HrLayout>
  );
}
