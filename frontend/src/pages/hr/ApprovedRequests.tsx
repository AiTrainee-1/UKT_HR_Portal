import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import {
  useListLeaveRequests, useUpdateLeaveStatus,
  getListLeaveRequestsQueryKey,
  useListPermissions, useUpdatePermissionStatus,
  getListPermissionsQueryKey,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Calendar, Clock, CheckCircle, XCircle, RefreshCw, Bell } from "lucide-react";

type Period = "today" | "week" | "all";

const PERIOD_LABELS: Record<Period, string> = {
  today: "Today",
  week: "This Week",
  all: "All",
};

type UnifiedItem =
  | { kind: "leave";       id: number; employeeName: string; employeeId: number; createdAt: string; status: string; label: string; meta: string }
  | { kind: "permission";  id: number; employeeName: string; employeeId: number; createdAt: string; status: string; label: string; meta: string };

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

  const { data: leaves, isLoading: leavesLoading } = useListLeaveRequests(undefined, {
    query: { refetchInterval: 30_000 },
  } as any);
  const { data: perms, isLoading: permsLoading } = useListPermissions(undefined, {
    refetchInterval: 30_000,
  } as any);

  const updateLeaveMutation  = useUpdateLeaveStatus();
  const updatePermMutation   = useUpdatePermissionStatus();

  const isLoading = leavesLoading || permsLoading;

  const unified: UnifiedItem[] = [
    ...(leaves ?? []).map(l => ({
      kind:         "leave" as const,
      id:           l.id,
      employeeName: l.employeeName ?? (l as any).employeeCode ?? `#${l.employeeId}`,
      employeeId:   l.employeeId,
      createdAt:    l.createdAt,
      status:       l.status,
      label:        `${l.type.charAt(0).toUpperCase() + l.type.slice(1)} Leave`,
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

  const goToDetail = (item: UnifiedItem) => {
    if (item.kind === "leave")      navigate("/hr/leave?tab=leaves");
    else                            navigate("/hr/leave?tab=permissions");
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListPermissionsQueryKey() });
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
              Leave & Permission requests from the Employee App — auto-refreshes every 30 s
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
            Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <Skeleton className="h-5 w-40 mb-2" />
                  <Skeleton className="h-4 w-64" />
                </CardContent>
              </Card>
            ))
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
              const Icon = item.kind === "leave" ? Calendar : Clock;
              const iconColor = item.kind === "leave" ? "text-blue-600 bg-blue-50" : "text-cyan-600 bg-cyan-50";
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
                            onClick={() => item.kind === "leave" ? approveLeave(item.id) : approvePerm(item.id)}
                            disabled={updateLeaveMutation.isPending || updatePermMutation.isPending}>
                            <CheckCircle size={12} /> Approve
                          </Button>
                          <Button size="sm" variant="outline"
                            className="h-7 gap-1 text-red-600 border-red-200 hover:bg-red-50 text-xs px-2"
                            onClick={() => item.kind === "leave" ? rejectLeave(item.id) : rejectPerm(item.id)}
                            disabled={updateLeaveMutation.isPending || updatePermMutation.isPending}>
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
      </div>
    </HrLayout>
  );
}
