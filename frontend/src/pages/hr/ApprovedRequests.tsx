import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  useListLeaveRequests, useUpdateLeaveStatus,
  getListLeaveRequestsQueryKey,
  useListPermissions, useUpdatePermissionStatus,
  getListPermissionsQueryKey,
  useListOutpassRequests, useUpdateOutpassRequestStatus,
  getListOutpassRequestsQueryKey,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Calendar, Clock, CheckCircle, XCircle, RefreshCw, Bell, DoorOpen, MapPin, User, FileText, Building2, Briefcase } from "lucide-react";
import { CircleLoader } from "@/components/ui/CircleLoader";

type Period = "today" | "week" | "all";

const PERIOD_LABELS: Record<Period, string> = {
  today: "Today",
  week: "This Week",
  all: "All",
};

type UnifiedItem =
  | { kind: "leave";       id: number; employeeName: string; employeeId: number; createdAt: string; status: string; label: string; meta: string }
  | { kind: "permission";  id: number; employeeName: string; employeeId: number; createdAt: string; status: string; label: string; meta: string }
  | { kind: "outpass";     id: number; employeeName: string; employeeId: number; createdAt: string; status: string; label: string; meta: string };

const STATUS_CLS: Record<string, string> = {
  pending:  "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-green-50 text-green-700 border-green-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

function isWithinPeriod(dateStr: string, period: Period): boolean {
  const d = new Date(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "today") return d >= todayStart;
  if (period === "week") {
    const weekStart = new Date(todayStart);
    weekStart.setDate(todayStart.getDate() - 6);
    return d >= weekStart;
  }
  return true;
}

export default function ApprovedRequests() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [period, setPeriod] = useState<Period>("today");
  const [selectedOutpassId, setSelectedOutpassId] = useState<number | null>(null);

  const { data: leaves, isLoading: leavesLoading } = useListLeaveRequests(undefined, {
    query: { refetchInterval: 30_000 },
  } as any);
  const { data: perms, isLoading: permsLoading } = useListPermissions(undefined, {
    refetchInterval: 30_000,
  } as any);
  // Only manually-requested Outpasses show up here for HR review -an
  // On-Duty-derived one is already approved by definition (see
  // geo_attendance_views.py::_create_outpass_from_on_duty), so it would
  // never have anything for HR to act on.
  const { data: outpasses, isLoading: outpassesLoading } = useListOutpassRequests();

  const updateLeaveMutation  = useUpdateLeaveStatus();
  const updatePermMutation   = useUpdatePermissionStatus();
  const updateOutpassMutation = useUpdateOutpassRequestStatus();

  const isLoading = leavesLoading || permsLoading || outpassesLoading;

  const unified: UnifiedItem[] = [
    ...(leaves ?? []).map(l => ({
      kind:         "leave" as const,
      id:           l.id,
      employeeName: l.employeeName ?? (l as any).employeeCode ?? `#${l.employeeId}`,
      employeeId:   l.employeeId,
      createdAt:    l.createdAt,
      status:       l.status,
      label:        l.isHalfDay
        ? `Half Day Leave (${l.halfDaySlot === "afternoon" ? "Afternoon" : "Morning"})`
        : `${l.type.charAt(0).toUpperCase() + l.type.slice(1)} Leave`,
      meta:         `${l.startDate} → ${l.endDate}${l.reason ? ` · ${l.reason}` : ""}`,
    })),
    ...(perms ?? []).map(p => ({
      kind:         "permission" as const,
      id:           p.id,
      employeeName: p.employeeName,
      employeeId:   p.employeeId,
      createdAt:    p.createdAt ?? "",
      status:       p.status,
      label:        "Permission Request",
      meta:         `${p.date}${p.permissionTime ? ` at ${p.permissionTime}` : ""}${p.reason ? ` · ${p.reason}` : ""}`,
    })),
    ...(outpasses ?? []).filter(o => o.source === "manual").map(o => ({
      kind:         "outpass" as const,
      id:           o.id,
      employeeName: o.employee?.name ?? `#${o.employeeId}`,
      employeeId:   o.employeeId,
      createdAt:    o.createdAt,
      status:       o.status,
      label:        "Outpass Request",
      meta:         `${o.destination} · ${o.reason}`,
    })),
  ]
    .filter(item => item.createdAt && isWithinPeriod(item.createdAt, period))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const pendingCount  = unified.filter(i => i.status === "pending").length;
  const approvedCount = unified.filter(i => i.status === "approved").length;
  const rejectedCount = unified.filter(i => i.status === "rejected").length;

  const approveLeave = async (id: number) => {
    try {
      await updateLeaveMutation.mutateAsync({ id, data: { status: "approved" as any } });
      toast({ title: "Leave approved" });
      queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });
    } catch {
      toast({ title: "Failed to approve", variant: "destructive" });
    }
  };

  const rejectLeave = async (id: number) => {
    try {
      await updateLeaveMutation.mutateAsync({ id, data: { status: "rejected" as any } });
      toast({ title: "Leave rejected" });
      queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });
    } catch {
      toast({ title: "Failed to reject", variant: "destructive" });
    }
  };

  const approvePerm = async (id: number) => {
    try {
      await updatePermMutation.mutateAsync({ id, data: { status: "approved" } });
      toast({ title: "Permission approved" });
      queryClient.invalidateQueries({ queryKey: getListPermissionsQueryKey() });
    } catch {
      toast({ title: "Failed to approve", variant: "destructive" });
    }
  };

  const rejectPerm = async (id: number) => {
    try {
      await updatePermMutation.mutateAsync({ id, data: { status: "rejected" } });
      toast({ title: "Permission rejected" });
      queryClient.invalidateQueries({ queryKey: getListPermissionsQueryKey() });
    } catch {
      toast({ title: "Failed to reject", variant: "destructive" });
    }
  };

  const approveOutpass = async (id: number) => {
    try {
      await updateOutpassMutation.mutateAsync({ id, data: { status: "approved" } });
      toast({ title: "Outpass approved" });
      queryClient.invalidateQueries({ queryKey: getListOutpassRequestsQueryKey() });
    } catch {
      toast({ title: "Failed to approve", variant: "destructive" });
    }
  };

  const rejectOutpass = async (id: number) => {
    try {
      await updateOutpassMutation.mutateAsync({ id, data: { status: "rejected" } });
      toast({ title: "Outpass rejected" });
      queryClient.invalidateQueries({ queryKey: getListOutpassRequestsQueryKey() });
    } catch {
      toast({ title: "Failed to reject", variant: "destructive" });
    }
  };

  const goToDetail = (item: UnifiedItem) => {
    if (item.kind === "leave")           navigate("/hr/leave?tab=leaves");
    else if (item.kind === "permission") navigate("/hr/leave?tab=permissions");
    else                                 setSelectedOutpassId(item.id);
  };

  const selectedOutpass = outpasses?.find(o => o.id === selectedOutpassId) ?? null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListPermissionsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListOutpassRequestsQueryKey() });
    toast({ title: "Refreshed" });
  };

  return (
    <HrLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
              <Bell size={22} className="text-amber-500" />
              Requests
              {pendingCount > 0 && (
                <Badge className="bg-amber-500 text-white text-xs">{pendingCount} pending</Badge>
              )}
            </h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Leave, Permission & Outpass requests from the Employee App -auto-refreshes every 30 s
            </p>
          </div>
          <Button variant="outline" size="sm" className="gap-2" onClick={refresh}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Pending",  value: pendingCount,  color: "text-amber-700 bg-amber-50 border-amber-100" },
            { label: "Approved", value: approvedCount, color: "text-green-700 bg-green-50 border-green-100" },
            { label: "Rejected", value: rejectedCount, color: "text-red-700 bg-red-50 border-red-100" },
          ].map(s => (
            <Card key={s.label} className={`border ${s.color.split(" ").slice(1).join(" ")}`}>
              <CardContent className="p-4">
                <p className={`text-2xl font-black ${s.color.split(" ")[0]}`}>{s.value}</p>
                <p className="text-xs font-medium text-gray-600 mt-0.5">{s.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Period filter */}
        <div className="flex items-center gap-2">
          <PillTabs
            items={(["today", "week", "all"] as Period[]).map((p) => ({ value: p, label: PERIOD_LABELS[p] }))}
            value={period}
            onChange={(v) => setPeriod(v as Period)}
          />
          <span className="text-xs text-gray-400 ml-1">{unified.length} request{unified.length !== 1 ? "s" : ""}</span>
        </div>

        {/* List */}
        <div className="space-y-3">
          {isLoading ? (
            <CircleLoader texts={["UK Textiles", "Requests", "Loading"]} />
          ) : unified.length === 0 ? (
            <div className="text-center py-16">
              <Bell size={36} className="mx-auto text-gray-200 mb-3" />
              <p className="text-muted-foreground text-sm">
                {period === "today" ? "No requests received today." : "No requests found."}
              </p>
            </div>
          ) : (
            unified.map((item, idx) => {
              const statusCls = STATUS_CLS[item.status] ?? STATUS_CLS.pending;
              const Icon = item.kind === "leave" ? Calendar : item.kind === "permission" ? Clock : DoorOpen;
              const iconColor = item.kind === "leave" ? "text-blue-600 bg-blue-50"
                : item.kind === "permission" ? "text-cyan-600 bg-cyan-50" : "text-teal-600 bg-teal-50";
              const timeStr = item.createdAt
                ? new Date(item.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
                : "";
              const dateStr = item.createdAt
                ? new Date(item.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
                : "";

              return (
                <Card key={`${item.kind}-${item.id}`}
                  className="border hover:shadow-sm transition-shadow cursor-pointer"
                  onClick={() => goToDetail(item)}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg shrink-0 mt-0.5 ${iconColor}`}>
                        <Icon size={15} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-bold text-sm text-gray-900">{item.employeeName}</p>
                          <Badge className={`text-xs border ${statusCls}`}>{item.status}</Badge>
                          <span className="text-xs font-medium text-gray-500">{item.label}</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{item.meta}</p>
                        <p className="text-xs text-gray-300 mt-1">{dateStr} · {timeStr}</p>
                      </div>
                      {item.status === "pending" && (
                        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                          <Button size="sm" variant="outline"
                            className="h-7 gap-1 text-green-700 border-green-200 hover:bg-green-50 text-xs px-2"
                            onClick={() => item.kind === "leave" ? approveLeave(item.id) : item.kind === "permission" ? approvePerm(item.id) : approveOutpass(item.id)}
                            disabled={updateLeaveMutation.isPending || updatePermMutation.isPending || updateOutpassMutation.isPending}>
                            <CheckCircle size={12} /> Approve
                          </Button>
                          <Button size="sm" variant="outline"
                            className="h-7 gap-1 text-red-600 border-red-200 hover:bg-red-50 text-xs px-2"
                            onClick={() => item.kind === "leave" ? rejectLeave(item.id) : item.kind === "permission" ? rejectPerm(item.id) : rejectOutpass(item.id)}
                            disabled={updateLeaveMutation.isPending || updatePermMutation.isPending || updateOutpassMutation.isPending}>
                            <XCircle size={12} /> Reject
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        {/* ── Outpass Request Detail Dialog ─────────────────────────────── */}
        {selectedOutpass && (
          <Dialog open onOpenChange={() => setSelectedOutpassId(null)}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Outpass Request Details</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-1">
                <div className="rounded-xl border bg-gray-50 p-4 space-y-3">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Employee</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-start gap-2">
                      <User size={14} className="mt-0.5 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-400">Name</p>
                        <p className="text-sm font-semibold text-gray-900">{selectedOutpass.employee?.name ?? `#${selectedOutpass.employeeId}`}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <FileText size={14} className="mt-0.5 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-400">Employee ID</p>
                        <p className="text-sm font-semibold text-gray-900">{selectedOutpass.employee?.employeeCode ?? `#${selectedOutpass.employeeId}`}</p>
                      </div>
                    </div>
                    {selectedOutpass.employee?.department && (
                      <div className="flex items-start gap-2">
                        <Building2 size={14} className="mt-0.5 text-gray-400 shrink-0" />
                        <div>
                          <p className="text-xs text-gray-400">Department</p>
                          <p className="text-sm font-semibold text-gray-900">{selectedOutpass.employee.department}</p>
                        </div>
                      </div>
                    )}
                    {selectedOutpass.employee?.designation && (
                      <div className="flex items-start gap-2">
                        <Briefcase size={14} className="mt-0.5 text-gray-400 shrink-0" />
                        <div>
                          <p className="text-xs text-gray-400">Designation</p>
                          <p className="text-sm font-semibold text-gray-900">{selectedOutpass.employee.designation}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Outpass Details</p>
                  <div className="flex items-start gap-2">
                    <MapPin size={14} className="mt-0.5 text-gray-400 shrink-0" />
                    <div>
                      <p className="text-xs text-gray-400">Destination</p>
                      <p className="text-sm font-semibold text-gray-900">{selectedOutpass.destination}</p>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Status</p>
                    <Badge className={`text-xs border ${STATUS_CLS[selectedOutpass.status] ?? STATUS_CLS.pending}`}>{selectedOutpass.status}</Badge>
                  </div>
                  {selectedOutpass.reason && (
                    <div>
                      <p className="text-xs text-gray-400 mb-1">Reason</p>
                      <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 border">{selectedOutpass.reason}</p>
                    </div>
                  )}
                  {selectedOutpass.reviewComment && (
                    <div>
                      <p className="text-xs text-gray-400 mb-1">HR/HOD Comment</p>
                      <p className="text-sm text-blue-700 bg-blue-50 rounded-lg p-3 border border-blue-100">{selectedOutpass.reviewComment}</p>
                    </div>
                  )}
                  {selectedOutpass.approvedBy && (
                    <p className="text-xs text-gray-500">
                      {selectedOutpass.status === "rejected" ? "Rejected By" : "Approved By"}: <strong>{selectedOutpass.approvedBy}</strong>
                      {selectedOutpass.approverRole === "dept_head" ? " (Department Head)" : selectedOutpass.approverRole ? " (HR)" : ""}
                    </p>
                  )}
                  {selectedOutpass.scanStatus && selectedOutpass.scanStatus !== "not_applicable" && (
                    <div className="grid grid-cols-2 gap-3 rounded-lg border bg-gray-50 p-3">
                      <div>
                        <p className="text-xs text-gray-400">Gate Scan Status</p>
                        <p className="text-sm font-semibold text-gray-900">
                          {selectedOutpass.scanStatus === "exited" ? "Exited"
                            : selectedOutpass.scanStatus === "expired_unscanned" ? "Expired, Not Scanned"
                            : "Awaiting Exit Scan"}
                        </p>
                      </div>
                      {selectedOutpass.exitGateName && (
                        <div>
                          <p className="text-xs text-gray-400">Exit Gate</p>
                          <p className="text-sm font-semibold text-gray-900">{selectedOutpass.exitGateName}</p>
                        </div>
                      )}
                      {selectedOutpass.exitedAt && (
                        <div className="col-span-2">
                          <p className="text-xs text-gray-400">Exit Time</p>
                          <p className="text-sm font-semibold text-gray-900">{new Date(selectedOutpass.exitedAt).toLocaleString("en-IN")}</p>
                        </div>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-gray-300">
                    Submitted: {selectedOutpass.createdAt ? new Date(selectedOutpass.createdAt).toLocaleString("en-IN") : "—"}
                  </p>
                </div>

                {selectedOutpass.status === "pending" && (
                  <div className="flex gap-2 pt-1">
                    <Button className="flex-1 gap-1 bg-green-600 hover:bg-green-700"
                      onClick={() => { approveOutpass(selectedOutpass.id); setSelectedOutpassId(null); }}
                      disabled={updateOutpassMutation.isPending}>
                      <CheckCircle size={14} /> Approve
                    </Button>
                    <Button variant="outline" className="flex-1 gap-1 text-red-600 border-red-200 hover:bg-red-50"
                      onClick={() => { rejectOutpass(selectedOutpass.id); setSelectedOutpassId(null); }}
                      disabled={updateOutpassMutation.isPending}>
                      <XCircle size={14} /> Reject
                    </Button>
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </HrLayout>
  );
}
