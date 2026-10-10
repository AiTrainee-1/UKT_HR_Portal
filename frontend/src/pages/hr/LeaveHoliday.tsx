import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CalendarRange, Clock, Gift, Scale, Sunrise } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import {
  getListLeaveRequestsQueryKey,
  useDeleteLeaveRequest,
  useListLeaveRequests,
  useUpdateLeaveStatus,
} from "@/lib/api-client";
import { ConfirmDialog } from "./leave/ConfirmDialog";
import BalancesTab from "./leave/BalancesTab";
import CalendarTab from "./leave/CalendarTab";
import HolidaysTab from "./leave/HolidaysTab";
import LeaveDetailDialog from "./leave/LeaveDetailDialog";
import LeaveRequestsTab from "./leave/LeaveRequestsTab";
import PermissionsTab from "./leave/PermissionsTab";
import { longDate, type LeaveRow } from "./leave/logic";

const TABS = ["leaves", "halfDay", "permissions", "calendar", "holidays", "balances"] as const;
type Tab = (typeof TABS)[number];

/** The `?tab=` the page was opened on (the dashboard and the MD portal link to a tab), else the leave requests. */
const tabFromUrl = (): Tab => {
  const wanted = new URLSearchParams(window.location.search).get("tab");
  return TABS.includes(wanted as Tab) ? (wanted as Tab) : "leaves";
};

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function LeaveHoliday() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>(tabFromUrl);
  const [selected, setSelected] = useState<LeaveRow | null>(null);
  const [toDelete, setToDelete] = useState<LeaveRow | null>(null);
  const today = useMemo(localToday, []);

  // Polled: this page has no other live-update mechanism, and a mobile HOD approval writes straight to the DB with no
  // signal back to whatever HR is looking at (ApprovedRequests.tsx polls the same query keys for the same reason).
  const leavesQuery = useListLeaveRequests(undefined, { query: { refetchInterval: 30_000 } } as any);
  const all = useMemo(() => (leavesQuery.data ?? []) as unknown as LeaveRow[], [leavesQuery.data]);
  // Half-day requests get their own tab, so a half day is never listed twice.
  const fullDay = useMemo(() => all.filter((l) => !l.isHalfDay), [all]);
  const halfDay = useMemo(() => all.filter((l) => l.isHalfDay), [all]);

  const updateMutation = useUpdateLeaveStatus();
  const deleteMutation = useDeleteLeaveRequest();
  const busy = updateMutation.isPending || deleteMutation.isPending;

  const decide = async (leave: LeaveRow, status: "approved" | "rejected") => {
    try {
      await updateMutation.mutateAsync({ id: leave.id, data: { status } });
    } catch (err) {
      toast({
        title: "Failed to update leave request",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
      return;
    }
    toast({ title: `Leave request ${status}` });
    queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });
  };

  const remove = async (leave: LeaveRow) => {
    try {
      await deleteMutation.mutateAsync(leave.id);
    } catch {
      toast({ title: "Failed to delete leave request", variant: "destructive" });
      return;
    }
    toast({ title: "Leave request deleted" });
    queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });
  };

  const shared = {
    loading: leavesQuery.isLoading,
    failed: leavesQuery.isError,
    onRetry: () => void leavesQuery.refetch(),
    today,
    busy,
    onOpen: setSelected,
    onDecide: decide,
    onDelete: setToDelete,
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Leave & Holiday</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Manage leave requests, permissions, leave balances and company holidays
            </p>
          </div>
          <RefreshButton />
        </div>

        <div>
          <div className="max-w-full overflow-x-auto pb-1">
            <PillTabs
              items={[
                { value: "leaves", label: "Leave Requests", icon: <CalendarDays size={14} /> },
                { value: "halfDay", label: "Half-Day Leave", icon: <Sunrise size={14} /> },
                { value: "permissions", label: "Permissions", icon: <Clock size={14} /> },
                { value: "calendar", label: "Calendar", icon: <CalendarRange size={14} /> },
                { value: "holidays", label: "Holidays", icon: <Gift size={14} /> },
                { value: "balances", label: "Balances", icon: <Scale size={14} /> },
              ]}
              value={tab}
              onChange={(v) => setTab(v as Tab)}
            />
          </div>

          {tab === "leaves" && <LeaveRequestsTab mode="leave" rows={fullDay} {...shared} />}
          {tab === "halfDay" && <LeaveRequestsTab mode="half" rows={halfDay} {...shared} />}
          {tab === "permissions" && <PermissionsTab />}
          {tab === "calendar" && (
            <CalendarTab
              leaves={all}
              loading={shared.loading}
              failed={shared.failed}
              onRetry={shared.onRetry}
              today={today}
            />
          )}
          {tab === "holidays" && <HolidaysTab today={today} />}
          {tab === "balances" && <BalancesTab />}
        </div>

        <LeaveDetailDialog leave={selected} onClose={() => setSelected(null)} onDecide={decide} busy={busy} />
        <ConfirmDialog
          open={toDelete !== null}
          title="Delete this leave request?"
          description={
            toDelete
              ? `${toDelete.employeeName ?? "This employee"}'s request for ${longDate(toDelete.startDate)} will be removed. This cannot be undone.`
              : ""
          }
          confirmLabel="Delete"
          onCancel={() => setToDelete(null)}
          onConfirm={() => {
            if (toDelete) void remove(toDelete);
            setToDelete(null);
          }}
          testId="confirm-delete-leave"
        />
      </div>
    </HrLayout>
  );
}
