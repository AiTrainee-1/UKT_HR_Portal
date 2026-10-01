import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { PipelineNote, WaitingChip } from "@/components/ApprovalTrail";
import { explainsWaiting, hrCanAct, hrCanReject, waitingText } from "@/lib/approval-workflow";
import {
  useMissingPunchRequestsHR, useUpdateMissingPunchHR,
  type MissingPunchItem, type MissingPunchSlot,
} from "@/lib/api-client/custom-hooks";
import {
  Fingerprint, CheckCircle2, XCircle, Hourglass, ShieldAlert, ShieldCheck, Info,
} from "lucide-react";

const STAGE_LABEL: Record<string, string> = {
  pending_hod: "Awaiting Department Head",
  pending_hr: "Awaiting HR",
  approved: "Approved",
  rejected: "Rejected",
};

// Mirrors the employee-facing apps -purely descriptive, never the source of
// truth for real P1-P4 identity (the attendance engine derives that from
// punch time, not a stored label).
const PUNCH_SLOT_LABEL: Record<MissingPunchSlot, string> = {
  morning_in: "Morning Check-In",
  lunch_out: "Lunch Check-Out",
  lunch_in: "Lunch Check-In",
  evening_out: "Evening Check-Out",
};

function punchLabel(r: MissingPunchItem): string {
  return r.punchSlot ? PUNCH_SLOT_LABEL[r.punchSlot] : (r.punchType === "IN" ? "Check-In" : "Check-Out");
}

export default function MissingPunch() {
  const { toast } = useToast();
  const [tab, setTab] = useState("pending");

  const { data: items, isLoading } = useMissingPunchRequestsHR("all");
  const updateMutation = useUpdateMissingPunchHR();

  const all = items ?? [];
  const pendingHod = all.filter(r => r.status === "pending_hod");
  const pendingHr  = all.filter(r => r.status === "pending_hr");
  const pending    = [...pendingHod, ...pendingHr];
  const approved   = all.filter(r => r.status === "approved");
  const rejected   = all.filter(r => r.status === "rejected");

  // What HR may decide follows the approval pipeline (User Management -> Approval Workflow Control), not the status
  // label: an older backend sends no pipeline, and then HR decides at "Awaiting HR" only, as it always did.
  const hrDecides = (r: MissingPunchItem) => hrCanAct(r.approval, r.status === "pending_hr");
  const hrRejects = (r: MissingPunchItem) => hrCanReject(r.approval, r.status === "pending_hr");
  const awaitingHr = pending.filter(hrDecides);

  const decide = async (r: MissingPunchItem, status: "approved" | "rejected") => {
    try {
      const result = await updateMutation.mutateAsync({ id: r.id, status });
      const passedOn = status === "approved" && result?.status !== "approved";
      toast({
        title: passedOn ? "Missing Punch approved" : `Missing Punch ${status}`,
        description: passedOn
          ? `${waitingText(result?.approval) ?? "Waiting for the next approval"}: it is added to attendance once that is done.`
          : status === "approved"
            ? `${punchLabel(r)} at ${r.punchTime} on ${r.date} has been added to ${r.employeeName}'s attendance.`
            : `${r.employeeName}'s Missing Punch request for ${r.date} was rejected.`,
      });
    } catch (err: any) {
      toast({ title: err?.data?.error ?? err?.message ?? "Failed to update", variant: "destructive" });
    }
  };

  const Row = ({ r }: { r: MissingPunchItem }) => (
    <div
      className="flex items-start gap-4 p-4 border rounded-xl hover:bg-gray-50 transition-colors flex-wrap"
      data-testid={`missing-punch-${r.id}`}
    >
      <div className="w-9 h-9 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
        <Fingerprint size={15} className="text-violet-500" />
      </div>
      <div className="flex-1 min-w-[220px]">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-bold text-gray-900">{r.employeeName}</p>
          <span className="text-xs font-mono text-gray-400">{r.employeeCode}</span>
          {r.department && <span className="text-xs text-gray-400">· {r.department}</span>}
          {explainsWaiting(r.approval) ? (
            <WaitingChip approval={r.approval} className="rounded" />
          ) : (
            <span className={`flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded ${
              r.status === "approved" ? "bg-green-50 text-green-700"
              : r.status === "rejected" ? "bg-red-50 text-red-600"
              : r.status === "pending_hr" ? "bg-blue-50 text-blue-700"
              : "bg-amber-50 text-amber-700"
            }`}>
              {r.status === "pending_hod" ? <ShieldAlert size={10} /> : r.status === "pending_hr" ? <ShieldCheck size={10} /> : null}
              {STAGE_LABEL[r.status]}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-1">
          <strong className="font-mono">{r.date}</strong> · {punchLabel(r)} at{" "}
          <strong className="font-mono">{r.punchTime}</strong>
        </p>
        <p className="text-xs text-gray-700 mt-1 italic">"{r.reason}"</p>
        {r.hodReviewedBy && (
          <p className="text-[11px] text-gray-400 mt-1.5">
            HOD: {r.status === "rejected" && !r.hrReviewedBy ? "rejected" : "approved"} by {r.hodReviewedBy}
            {r.hodReviewComment ? ` -"${r.hodReviewComment}"` : ""}
          </p>
        )}
        {r.hrReviewedBy && (
          <p className="text-[11px] text-gray-400">
            HR: {r.status === "rejected" ? "rejected" : "approved"} by {r.hrReviewedBy}
            {r.hrReviewComment ? ` -"${r.hrReviewComment}"` : ""}
          </p>
        )}
        {!r.approval && r.status === "pending_hod" && (
          <p className="text-[11px] text-amber-600 mt-1">
            No Department Head has acted yet -HR can only approve once the Department Head approves first.
          </p>
        )}
        {r.approval && r.approval.currentStep !== null && !hrDecides(r) && (
          <p className="text-[11px] text-amber-600 mt-1">
            {waitingText(r.approval)}: HR cannot decide this request until that step is done.
          </p>
        )}
        {r.status === "approved" && (
          <p className="text-[11px] text-green-600 mt-1">
            Added to attendance as a real punch (source: Missing Punch) -flows through the normal attendance engine.
          </p>
        )}
      </div>
      {(hrDecides(r) || hrRejects(r)) && (
        <div className="flex items-center gap-2 shrink-0">
          {hrDecides(r) && (
            <Button
              size="sm" className="h-8 gap-1.5 text-xs bg-green-600 hover:bg-green-700"
              disabled={updateMutation.isPending}
              onClick={() => decide(r, "approved")}
            >
              <CheckCircle2 size={12} /> Approve
            </Button>
          )}
          {hrRejects(r) && (
            <Button
              size="sm" variant="destructive" className="h-8 gap-1.5 text-xs"
              disabled={updateMutation.isPending}
              onClick={() => decide(r, "rejected")}
            >
              <XCircle size={12} /> Reject
            </Button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Missing Punch</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Employee-reported forgotten punches.
            </p>
            <PipelineNote workflow="missing_punch" className="mt-1" />
          </div>
          <RefreshButton />
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Pending", value: pending.length, icon: Hourglass, cls: "text-amber-700", iconCls: "bg-amber-500" },
            { label: "HR can decide", value: awaitingHr.length, icon: ShieldCheck, cls: "text-blue-700", iconCls: "bg-blue-600" },
            { label: "Approved", value: approved.length, icon: CheckCircle2, cls: "text-green-700", iconCls: "bg-green-600" },
            { label: "Rejected", value: rejected.length, icon: XCircle, cls: "text-red-600", iconCls: "bg-red-500" },
          ].map(({ label, value, icon: Icon, cls, iconCls }) => (
            <Card key={label} className="border">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</p>
                  <div className={`p-1.5 rounded-lg ${iconCls}`}>
                    <Icon size={14} className="text-white" />
                  </div>
                </div>
                <p className={`text-3xl font-black leading-none ${cls}`}>{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-700">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            Requests are submitted from the employee mobile/web app with a date, time and reason.
            Who approves them, and in what order, is set in <strong>User Management → Approval Workflow Control</strong>
            (shown above); a Department Head decides from the mobile app when "Can approve missing punch" is switched
            on for them in HOD Assignment. Once the final approval is given, the punch is written to attendance and
            flows through the normal engine (punch-order rules, punctuality window, cross-midnight logic) exactly like
            a real biometric punch.
          </span>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <PillTabs
            items={[
              { value: "pending", label: `Pending (${pending.length})` },
              { value: "approved", label: `Approved (${approved.length})` },
              { value: "rejected", label: `Rejected (${rejected.length})` },
            ]}
            value={tab}
            onChange={(v) => setTab(v)}
          />

          {(["pending", "approved", "rejected"] as const).map(t => (
            <TabsContent key={t} value={t} className="mt-4 space-y-2">
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
              ) : (t === "pending" ? pending : t === "approved" ? approved : rejected).length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No {t} Missing Punch requests.
                </div>
              ) : (
                (t === "pending" ? pending : t === "approved" ? approved : rejected).map(r => (
                  <Row key={r.id} r={r} />
                ))
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </HrLayout>
  );
}
