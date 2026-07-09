import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useListCasualLeaves, useCasualLeaveEligibility, useCreateCasualLeave,
  useDecideCasualLeave, useDeleteCasualLeave,
  type CasualLeaveItem,
} from "@/lib/api-client/custom-hooks";
import {
  CalendarHeart, CheckCircle2, XCircle, Hourglass, Users, Plus,
  Trash2, ShieldCheck, Info,
} from "lucide-react";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const STATUS_BADGE: Record<string, string> = {
  pending:  "bg-amber-100 text-amber-800 border-amber-200",
  approved: "bg-green-100 text-green-800 border-green-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
};

export default function CasualLeave() {
  const { toast } = useToast();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [tab, setTab] = useState("pending");

  // "Apply on behalf" dialog — carries the eligibility reason so HR sees
  // immediately why an employee can't get another CL, instead of finding out
  // only after clicking Submit.
  const [applyFor, setApplyFor] = useState<{ employeeId: number; name: string; eligible: boolean; reason?: string | null } | null>(null);
  const [applyDate, setApplyDate] = useState(now.toISOString().slice(0, 10));
  const [applyReason, setApplyReason] = useState("");

  const { data: leaves, isLoading } = useListCasualLeaves({ month, year });
  const { data: eligibility, isLoading: eligLoading } = useCasualLeaveEligibility(month, year);
  const createMutation = useCreateCasualLeave();
  const decideMutation = useDecideCasualLeave();
  const deleteMutation = useDeleteCasualLeave();

  const all = leaves ?? [];
  const pending  = all.filter(l => l.status === "pending");
  const approved = all.filter(l => l.status === "approved");
  const rejected = all.filter(l => l.status === "rejected");
  const eligibleCount = (eligibility?.employees ?? []).filter(e => e.eligible).length;
  const usedThisMonthCount = (eligibility?.employees ?? []).filter(e => e.usedThisMonth).length;

  const decide = async (l: CasualLeaveItem, status: "approved" | "rejected") => {
    try {
      await decideMutation.mutateAsync({ id: l.id, status });
      toast({
        title: `Casual leave ${status}`,
        description: status === "approved"
          ? `${l.employeeName}'s attendance for ${l.date} is now marked Present (paid full day).`
          : `${l.employeeName}'s attendance for ${l.date} is marked as Leave.`,
      });
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to update", variant: "destructive" });
    }
  };

  const submitOnBehalf = async () => {
    if (!applyFor) return;
    try {
      await createMutation.mutateAsync({
        employeeId: applyFor.employeeId,
        date: applyDate,
        reason: applyReason || undefined,
      });
      toast({ title: `CL request created for ${applyFor.name}` });
      setApplyFor(null);
      setApplyReason("");
    } catch (err: any) {
      const reason = err?.data?.error ?? "Failed to create request";
      toast({ title: `Not eligible for ${applyFor.name}`, description: reason, variant: "destructive" });
    }
  };

  const CLRow = ({ l, showActions }: { l: CasualLeaveItem; showActions?: boolean }) => (
    <div className="flex items-center gap-3 p-3 border rounded-xl hover:bg-gray-50 transition-colors">
      <div className="w-9 h-9 rounded-lg bg-pink-50 flex items-center justify-center shrink-0">
        <CalendarHeart size={15} className="text-pink-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-bold text-gray-900">{l.employeeName}</p>
          <span className="text-xs font-mono text-gray-400">{l.employeeCode}</span>
          {l.department && <span className="text-xs text-gray-400">· {l.department}</span>}
        </div>
        <p className="text-xs text-gray-500 mt-0.5">
          <strong className="font-mono">{l.date}</strong>
          {l.reason ? ` — ${l.reason}` : ""}
        </p>
        {l.reviewedBy && (
          <p className="text-[11px] text-gray-400 mt-0.5">
            {l.status === "approved" ? "Approved" : "Rejected"} by {l.reviewedBy}
            {l.reviewerRole === "dept_head" ? " (Dept Head)" : " (HR)"}
            {l.reviewComment ? ` — ${l.reviewComment}` : ""}
          </p>
        )}
      </div>
      <Badge className={`text-xs border shrink-0 capitalize ${STATUS_BADGE[l.status]}`}>{l.status}</Badge>
      {showActions && l.status === "pending" && (
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            size="sm" className="h-8 gap-1 bg-green-600 hover:bg-green-700 text-xs"
            onClick={() => decide(l, "approved")} disabled={decideMutation.isPending}
          >
            <CheckCircle2 size={12} /> Approve
          </Button>
          <Button
            size="sm" variant="outline" className="h-8 gap-1 text-red-500 border-red-200 text-xs"
            onClick={() => decide(l, "rejected")} disabled={decideMutation.isPending}
          >
            <XCircle size={12} /> Reject
          </Button>
        </div>
      )}
      {l.status !== "pending" && (
        <button
          onClick={async () => {
            try {
              await deleteMutation.mutateAsync(l.id);
              toast({ title: "Record deleted" });
            } catch { toast({ title: "Delete failed", variant: "destructive" }); }
          }}
          className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 shrink-0"
          title="Delete record"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );

  return (
    <HrLayout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Casual Leave (CL)</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Paid leave · staff only · 1 per month · eligible after 6 months of service
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={month}
              onChange={e => setMonth(Number(e.target.value))}
              className="h-9 rounded-md border px-2 text-sm bg-background"
            >
              {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <Input
              type="number" min={2020} max={2035}
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              className="w-24 h-9"
            />
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {[
            { label: "Pending Requests", value: pending.length, icon: Hourglass, cls: "text-amber-700", iconCls: "bg-amber-500" },
            { label: "Approved", value: approved.length, icon: CheckCircle2, cls: "text-green-700", iconCls: "bg-green-600" },
            { label: "Rejected", value: rejected.length, icon: XCircle, cls: "text-red-600", iconCls: "bg-red-500" },
            { label: "Eligible Employees", value: eligLoading ? "…" : eligibleCount, icon: Users, cls: "text-blue-700", iconCls: "bg-blue-600" },
            { label: "Used This Month", value: eligLoading ? "…" : usedThisMonthCount, icon: CalendarHeart, cls: "text-pink-700", iconCls: "bg-pink-500" },
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

        {/* Workflow note */}
        <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-700">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            Requests are submitted from the employee mobile app. Either the <strong>Department Head</strong> (mobile,
            when "Can approve casual leave" is enabled in User Management) or <strong>HR</strong> (here) can decide.
            <strong> Approved</strong> → attendance for that date becomes <strong>Present (paid full day)</strong>.
            <strong> Rejected</strong> → the date is marked as <strong>Leave</strong>.
          </span>
        </div>

        {/* Tabs */}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="bg-gray-100">
            <TabsTrigger value="pending">
              Pending
              {pending.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-4 px-1 text-[10px] font-bold rounded-full bg-amber-500 text-white">
                  {pending.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="approved">Approved ({approved.length})</TabsTrigger>
            <TabsTrigger value="rejected">Rejected ({rejected.length})</TabsTrigger>
            <TabsTrigger value="eligible">Eligibility Board</TabsTrigger>
          </TabsList>

          {(["pending", "approved", "rejected"] as const).map(t => (
            <TabsContent key={t} value={t} className="mt-4 space-y-2">
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)
              ) : (t === "pending" ? pending : t === "approved" ? approved : rejected).length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  No {t} casual leave requests for {MONTH_NAMES[month - 1]} {year}.
                </div>
              ) : (
                (t === "pending" ? pending : t === "approved" ? approved : rejected).map(l => (
                  <CLRow key={l.id} l={l} showActions={t === "pending"} />
                ))
              )}
            </TabsContent>
          ))}

          {/* Eligibility board */}
          <TabsContent value="eligible" className="mt-4">
            <Card className="border">
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <ShieldCheck size={14} className="text-blue-500" />
                  CL Eligibility — {MONTH_NAMES[month - 1]} {year}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Staff employees only. Eligibility requires {eligibility?.eligibilityMonths ?? 6}+ months of service
                  and no CL already used this month.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {eligLoading ? (
                  <div className="p-4 space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-t border-b">
                        <tr>
                          {["Employee", "Department", "Joined", "Service", "This Month", "Status", ""].map(h => (
                            <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(eligibility?.employees ?? []).map(e => (
                          <tr key={e.employeeId} className={`border-b hover:bg-gray-50 ${e.eligible ? "" : "opacity-60"}`}>
                            <td className="px-4 py-2.5">
                              <p className="font-semibold text-gray-900">{e.employeeName}</p>
                              <p className="text-[11px] font-mono text-gray-400">{e.employeeCode}</p>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-gray-600">{e.department ?? "—"}</td>
                            <td className="px-4 py-2.5 text-xs font-mono text-gray-600">{e.joinDate ?? "—"}</td>
                            <td className="px-4 py-2.5 text-xs text-gray-600">
                              {e.serviceMonths != null ? `${e.serviceMonths} months` : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-xs">
                              {e.usedThisMonth ? (
                                <span className="text-gray-600">
                                  CL {e.usedStatus} · <span className="font-mono">{e.usedDate}</span>
                                </span>
                              ) : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-2.5">
                              {e.eligible ? (
                                <Badge className="text-xs border bg-green-100 text-green-800 border-green-200">Eligible</Badge>
                              ) : (
                                <span className="text-xs text-gray-400">{e.reason ?? (e.usedThisMonth ? "Already used" : "Not eligible")}</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <Button
                                size="sm" variant="outline" className="h-7 gap-1 text-xs"
                                onClick={() => setApplyFor({
                                  employeeId: e.employeeId, name: e.employeeName,
                                  eligible: e.eligible, reason: e.reason,
                                })}
                              >
                                <Plus size={11} /> Apply CL
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Apply-on-behalf dialog */}
      <Dialog open={!!applyFor} onOpenChange={open => { if (!open) setApplyFor(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Apply Casual Leave — {applyFor?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            {applyFor && !applyFor.eligible && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                <XCircle size={14} className="shrink-0 mt-0.5" />
                <span>
                  <strong>Not eligible for Casual Leave.</strong> {applyFor.reason ?? "This employee does not currently qualify."}
                </span>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">CL Date</Label>
              <Input type="date" value={applyDate} onChange={e => setApplyDate(e.target.value)} disabled={!applyFor?.eligible} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Reason (optional)</Label>
              <Input
                placeholder="e.g. Family function" value={applyReason}
                onChange={e => setApplyReason(e.target.value)} disabled={!applyFor?.eligible}
              />
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setApplyFor(null)}>Cancel</Button>
              <Button
                className="flex-1" onClick={submitOnBehalf}
                disabled={createMutation.isPending || !applyFor?.eligible}
              >
                {createMutation.isPending ? "Submitting…" : "Submit Request"}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground -mt-1">
              The request starts as Pending — approve it from the Pending tab (or the Department Head
              can approve it on mobile).
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
