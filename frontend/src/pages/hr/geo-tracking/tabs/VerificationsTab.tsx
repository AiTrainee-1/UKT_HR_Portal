// Geo Attendance -> Punch Verifications: the per-punch selfie + GPS check (HR only). An employee punches up to four times a day
// without waiting for review, so the punches are grouped by On-Duty request: one card per request with the one decision that
// covers every punch under it, and a row per punch for the exception (one bad punch in an otherwise good day).
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock,
  Image as ImageIcon,
  MapPinned,
  Navigation,
  XCircle,
} from "lucide-react";
import { Chip, EmptyNote } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import {
  useOnDutyPunchVerificationsHR,
  useUpdateOnDutyPunchVerificationHR,
  useUpdateOnDutySessionPunchesHR,
  type OnDutyPunchVerificationItem,
} from "@/lib/api-client/custom-hooks";
import PunchPhotosDialog from "../PunchPhotos";
import {
  CountText,
  ListSkeleton,
  Note,
  PUNCH_STATUS_LABEL,
  PUNCH_TONE,
  PersonCell,
  SessionChip,
  ToolbarCard,
} from "../kit";
import PunchLocationDialog from "./PunchLocationDialog";

type Filter = "pending" | "approved" | "rejected";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

const EMPTY_HINT: Record<Filter, string> = {
  pending: "Punches with a photo and a GPS position wait here until HR approves them into attendance.",
  approved: "Punches HR approved appear here.",
  rejected: "Punches HR rejected appear here.",
};

type Group = { head: OnDutyPunchVerificationItem; punches: OnDutyPunchVerificationItem[]; pendingCount: number };

/** One card per On-Duty request, newest first; its punches in the order they were taken. */
export function groupBySession(verifications: readonly OnDutyPunchVerificationItem[]): Group[] {
  const bySession = new Map<number, OnDutyPunchVerificationItem[]>();
  for (const v of verifications) {
    const list = bySession.get(v.sessionId);
    if (list) list.push(v);
    else bySession.set(v.sessionId, [v]);
  }
  return [...bySession.values()]
    .map((punches) => ({
      head: punches[0],
      punches: [...punches].sort((a, b) => a.punchNumber - b.punchNumber),
      pendingCount: punches.filter((p) => p.status === "pending").length,
    }))
    .sort((a, b) => ((a.head.createdAt ?? "") < (b.head.createdAt ?? "") ? 1 : -1));
}

function PunchRow({
  v,
  busy,
  onPhotos,
  onMap,
  onDecide,
}: {
  v: OnDutyPunchVerificationItem;
  busy: boolean;
  onPhotos: (v: OnDutyPunchVerificationItem) => void;
  onMap: (v: OnDutyPunchVerificationItem) => void;
  onDecide: (v: OnDutyPunchVerificationItem, status: "approved" | "rejected") => void;
}) {
  const waitingOnRequest = !v.sessionApproved;
  return (
    <div
      className="grid gap-x-4 gap-y-2 p-3 sm:px-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      data-testid="punch-row"
      data-punch-id={v.id}
    >
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={v.punchType === "IN" ? "success" : "caution"}>
            #{v.punchNumber} {v.punchType === "IN" ? "CHECK-IN" : "CHECK-OUT"}
          </Chip>
          <Chip tone={PUNCH_TONE[v.status]}>{PUNCH_STATUS_LABEL[v.status]}</Chip>
          {v.isMocked && (
            <Chip tone="danger" icon={AlertTriangle}>
              Simulated location
            </Chip>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
          <span className="flex items-center gap-1 font-medium tabular-nums">
            <Clock size={12} className="text-gray-400" /> {v.punchTime.slice(0, 5)}
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-gray-500">
            <MapPinned size={12} className="text-gray-400" /> {v.latitude.toFixed(5)}, {v.longitude.toFixed(5)}
          </span>
          <button
            type="button"
            onClick={() => onMap(v)}
            className="flex items-center gap-1 font-semibold text-[#006496] hover:underline"
          >
            <Navigation size={12} /> View on map
          </button>
        </div>
        {v.hrReviewedBy && (
          <p className="text-[11px] text-gray-500">
            {v.status === "rejected" ? "Rejected" : "Approved"} by{" "}
            <b className="font-semibold text-gray-700">{v.hrReviewedBy}</b>
            {v.hrReviewComment ? ` - "${v.hrReviewComment}"` : ""}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => onPhotos(v)}>
          <ImageIcon size={12} /> {v.hasPhoto2 ? "Photos (2)" : "Photo"}
        </Button>
        {/* Per-punch actions stay for the exception case: one bad punch in an otherwise good day. The bulk buttons in the
            header are the normal path. */}
        {v.status === "pending" && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs text-green-700 hover:text-green-800"
              disabled={busy || waitingOnRequest}
              title={
                waitingOnRequest ? "The On-Duty request this punch belongs to is still awaiting approval." : undefined
              }
              onClick={() => onDecide(v, "approved")}
            >
              <CheckCircle2 size={12} /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs text-red-600 hover:text-red-700"
              disabled={busy}
              onClick={() => onDecide(v, "rejected")}
            >
              <XCircle size={12} /> Reject
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerificationsTab() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<Filter>("pending");
  const { data: verifications, isLoading } = useOnDutyPunchVerificationsHR(statusFilter);
  const updateMutation = useUpdateOnDutyPunchVerificationHR();
  const bulkMutation = useUpdateOnDutySessionPunchesHR();
  const [photoOf, setPhotoOf] = useState<OnDutyPunchVerificationItem | null>(null);
  const [mapPunch, setMapPunch] = useState<OnDutyPunchVerificationItem | null>(null);

  const groups = useMemo(() => groupBySession(verifications ?? []), [verifications]);
  const punchTotal = (verifications ?? []).length;

  const handleDecision = async (v: OnDutyPunchVerificationItem, status: "approved" | "rejected") => {
    try {
      await updateMutation.mutateAsync({ id: v.id, status });
      toast({
        title: `Punch ${status}`,
        description: `${v.employeeName}'s punch #${v.punchNumber} (${v.punchType === "IN" ? "Check-In" : "Check-Out"}).`,
      });
    } catch (err: unknown) {
      toast({
        title: "Failed to update punch",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  const handleBulk = async (head: OnDutyPunchVerificationItem, status: "approved" | "rejected") => {
    try {
      const res = await bulkMutation.mutateAsync({ sessionId: head.sessionId, status });
      toast({
        title: `${res.updated} punch${res.updated === 1 ? "" : "es"} ${status}`,
        description: `${head.employeeName} - On-Duty to "${head.sessionDestination}".`,
      });
    } catch (err: unknown) {
      toast({
        title: "Failed to update punches",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  const busy = updateMutation.isPending || bulkMutation.isPending;

  return (
    <div className="space-y-4" data-testid="tab-verifications">
      <ToolbarCard>
        <PillTabs items={FILTERS} value={statusFilter} onChange={(v) => setStatusFilter(v as Filter)} size="sm" />
        {!isLoading && (
          <CountText testId="verifications-count">
            {punchTotal} {statusFilter} punch{punchTotal === 1 ? "" : "es"} · {groups.length} request
            {groups.length === 1 ? "" : "s"}
          </CountText>
        )}
      </ToolbarCard>

      {isLoading ? (
        <ListSkeleton />
      ) : groups.length === 0 ? (
        <EmptyNote icon={Camera} title={`No ${statusFilter} punch verifications.`} hint={EMPTY_HINT[statusFilter]} />
      ) : (
        <div className="grid gap-3">
          {groups.map(({ head, punches, pendingCount }) => (
            <article
              key={head.sessionId}
              className="overflow-hidden rounded-2xl border bg-white"
              data-testid="verification-card"
              data-session-id={head.sessionId}
            >
              {/* Request header: who, where, and the one decision covering every punch listed underneath. */}
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b bg-slate-50 px-4 py-3">
                <div className="min-w-[min(100%,15rem)] flex-1 space-y-2">
                  <PersonCell
                    name={head.employeeName}
                    code={head.employeeCode}
                    sub={`${head.department ?? "No department"} · ${head.punchDate}`}
                  />
                  <p className="text-sm text-gray-800">
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">On-Duty to</span>{" "}
                    <span className="font-medium">&ldquo;{head.sessionDestination}&rdquo;</span>
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Chip tone="neutral">
                      {punches.length} punch{punches.length === 1 ? "" : "es"}
                    </Chip>
                    {head.sessionApproved ? (
                      <Chip tone="success">Request approved</Chip>
                    ) : (
                      <SessionChip status={head.sessionStatus} />
                    )}
                  </div>
                  {!head.sessionApproved && pendingCount > 0 && (
                    <Note tone="warn" className="inline-flex w-auto">
                      Approve the On-Duty request on the Approvals tab - that accepts all {pendingCount} punch
                      {pendingCount === 1 ? "" : "es"} with it.
                    </Note>
                  )}
                </div>
                {pendingCount > 0 && (
                  <div className="flex items-center gap-2" data-testid="verification-bulk">
                    <Button
                      size="sm"
                      className="h-9 gap-1.5 bg-green-600 text-xs hover:bg-green-700"
                      disabled={busy || !head.sessionApproved}
                      title={
                        head.sessionApproved
                          ? undefined
                          : "The On-Duty request these punches belong to is still awaiting approval."
                      }
                      onClick={() => void handleBulk(head, "approved")}
                    >
                      <CheckCircle2 size={13} /> Approve all {pendingCount}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-9 gap-1.5 text-xs"
                      disabled={busy}
                      onClick={() => void handleBulk(head, "rejected")}
                    >
                      <XCircle size={13} /> Reject all
                    </Button>
                  </div>
                )}
              </div>

              <div className="divide-y">
                {punches.map((v) => (
                  <PunchRow
                    key={v.id}
                    v={v}
                    busy={busy}
                    onPhotos={setPhotoOf}
                    onMap={setMapPunch}
                    onDecide={(p, s) => void handleDecision(p, s)}
                  />
                ))}
              </div>
            </article>
          ))}
        </div>
      )}

      <PunchPhotosDialog verification={photoOf} onClose={() => setPhotoOf(null)} />
      <PunchLocationDialog verification={mapPunch} onClose={() => setMapPunch(null)} />
    </div>
  );
}
