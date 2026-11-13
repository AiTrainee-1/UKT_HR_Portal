import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { CalendarDays, CalendarRange, Clock, Gift, Scale, Sunrise } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { PillTabs } from "@/components/ui/pill-tabs";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  getListLeaveRequestsQueryKey,
  useDeleteLeaveRequest,
  useListLeaveRequests,
  useUpdateLeaveStatus,
} from "@/lib/api-client";
import { moduleForPath } from "@/lib/permission-modules";
import { pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";
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

// Each tab's own permission key (Account Management -> Roles & Permissions); a key with no setting follows "leave".
const TAB_KEY: Record<Tab, string> = {
  leaves: "leave.requests",
  halfDay: "leave.half_day",
  permissions: "leave.permissions",
  calendar: "leave.calendar",
  holidays: "leave.holidays",
  balances: "leave.balances",
};

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
  const { user } = useAuth();
  const [location] = useLocation();
  const level = useLevel();
  // Only the tabs this role may see: a hidden tab is never shown (or mounted), also when ?tab= asks for it.
  const visibleTabs = visibleItems(TABS, (t) => TAB_KEY[t], level);
  const [askedTab, setTab] = useState<Tab>(tabFromUrl);
  const tab = pickVisible(askedTab, visibleTabs);
  // A tab this role may only VIEW on a page it may edit: lock that tab's change buttons (HrLayout locks a View-only page).
  const tabViewOnly =
    visibleTabs.length > 0 &&
    !isRouteViewOnly(user, location, moduleForPath(location)) &&
    level(TAB_KEY[tab]) === "view";
  useViewOnlyLock(tabViewOnly, tab);
  // The leave list feeds the Leave Requests, Half-Day and Calendar tabs only: not loaded when all three are hidden.
  const needsLeaves = visibleTabs.some((t) => t === "leaves" || t === "halfDay" || t === "calendar");
  const [selected, setSelected] = useState<LeaveRow | null>(null);
  const [toDelete, setToDelete] = useState<LeaveRow | null>(null);
  const today = useMemo(localToday, []);

  // Polled: this page has no other live-update mechanism, and a mobile HOD approval writes straight to the DB with no
  // signal back to whatever HR is looking at (ApprovedRequests.tsx polls the same query keys for the same reason).
  const leavesQuery = useListLeaveRequests(undefined, {
    query: { refetchInterval: 60_000, enabled: needsLeaves },
  } as any);
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
          {visibleTabs.length === 0 && (
            <p
              className="rounded-2xl bg-white p-6 text-center text-sm text-muted-foreground shadow-sm"
              data-testid="leave-nothing-open"
            >
              Nothing on this page is open to your role.
            </p>
          )}
          <div className="max-w-full overflow-x-auto pb-1" hidden={visibleTabs.length === 0}>
            <PillTabs
              items={visibleItems(
                [
                  { value: "leaves", label: "Leave Requests", icon: <CalendarDays size={14} /> },
                  { value: "halfDay", label: "Half-Day Leave", icon: <Sunrise size={14} /> },
                  { value: "permissions", label: "Permissions", icon: <Clock size={14} /> },
                  { value: "calendar", label: "Calendar", icon: <CalendarRange size={14} /> },
                  { value: "holidays", label: "Holidays", icon: <Gift size={14} /> },
                  { value: "balances", label: "Balances", icon: <Scale size={14} /> },
                ],
                (t) => TAB_KEY[t.value as Tab],
                level,
              )}
              value={tab}
              onChange={(v) => setTab(v as Tab)}
            />
          </div>
          {tabViewOnly && (
            <div className="mb-3 mt-2">
              <ViewOnlyTabNote show />
            </div>
          )}

          {visibleTabs.includes("leaves") && tab === "leaves" && (
            <LeaveRequestsTab mode="leave" rows={fullDay} {...shared} />
          )}
          {visibleTabs.includes("halfDay") && tab === "halfDay" && (
            <LeaveRequestsTab mode="half" rows={halfDay} {...shared} />
          )}
          {visibleTabs.includes("permissions") && tab === "permissions" && <PermissionsTab />}
          {visibleTabs.includes("calendar") && tab === "calendar" && (
            <CalendarTab
              leaves={all}
              loading={shared.loading}
              failed={shared.failed}
              onRetry={shared.onRetry}
              today={today}
            />
          )}
          {visibleTabs.includes("holidays") && tab === "holidays" && <HolidaysTab today={today} />}
          {visibleTabs.includes("balances") && tab === "balances" && <BalancesTab />}
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
