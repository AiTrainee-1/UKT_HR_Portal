// Geo Attendance -> Tracking Settings: the rules of geo-tracking (one card, see TrackingRulesCard) and the list of employees HR
// switched live tracking on for. Switching on is per employee or for everyone at once (asked first, since it changes every
// active employee). Employees with live tracking on appear under "Tracking-Enabled Employees" on the Live Map.
import { useMemo, useState } from "react";
import { Radar, Search, Users, UserX } from "lucide-react";
import { KpiTile, EmptyNote } from "@/components/payroll/kit/parts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useListEmployees, type Employee } from "@/lib/api-client";
import { useBulkUpdateLocationTracking, useUpdateEmployeeLocationTracking } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { PersonCell, ToolbarCard } from "../kit";
import TrackingRulesCard from "../TrackingRulesCard";

type Filter = "all" | "enabled" | "disabled";

export default function TrackingSettingsTab() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [bulkConfirm, setBulkConfirm] = useState<null | boolean>(null);
  const { data: employees, isLoading } = useListEmployees({ status: "active" });
  const toggleMutation = useUpdateEmployeeLocationTracking();
  const bulkMutation = useBulkUpdateLocationTracking();

  const withEnabled = useMemo(
    () =>
      (employees ?? []).map((e) => ({
        ...e,
        trackingEnabled: (e as Employee & { locationTrackingEnabled?: boolean }).locationTrackingEnabled ?? false,
      })),
    [employees],
  );
  const enabledCount = withEnabled.filter((e) => e.trackingEnabled).length;
  const disabledCount = withEnabled.length - enabledCount;

  const q = search.trim().toLowerCase();
  const filtered = withEnabled
    .filter(
      (e) => !q || e.employeeCode.toLowerCase().includes(q) || `${e.firstName} ${e.lastName}`.toLowerCase().includes(q),
    )
    .filter((e) => (filter === "all" ? true : filter === "enabled" ? e.trackingEnabled : !e.trackingEnabled));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageSafe = Math.min(page, totalPages);
  const paged = filtered.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

  const handleToggle = async (emp: Employee, next: boolean) => {
    try {
      await toggleMutation.mutateAsync({ employeeId: emp.id, enabled: next });
      toast({
        title: next ? "Live tracking enabled" : "Live tracking disabled",
        description: `${emp.firstName} ${emp.lastName}`,
      });
    } catch {
      toast({ title: "Failed to update tracking", variant: "destructive" });
    }
  };

  const handleBulkToggle = async (enabled: boolean) => {
    try {
      const res = await bulkMutation.mutateAsync({ enabled });
      toast({
        title: enabled ? "Live tracking enabled for everyone" : "Live tracking disabled for everyone",
        description: `${res.updated} employee${res.updated === 1 ? "" : "s"} updated`,
      });
    } catch {
      toast({ title: "Failed to update tracking", variant: "destructive" });
    } finally {
      setBulkConfirm(null);
    }
  };

  return (
    <div className="space-y-5" data-testid="tab-tracking">
      <TrackingRulesCard />

      <section className="space-y-3" data-testid="tracking-employees">
        <div>
          <h3 className="text-base font-bold text-gray-900">Live tracking by employee</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Employees with live tracking switched on are listed under &ldquo;Tracking-Enabled Employees&rdquo; on the
            Live Map.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            label="Total Employees"
            value={withEnabled.length}
            icon={Users}
            tone="bg-slate-50 text-slate-800"
            loading={isLoading}
            testId="tracking-total"
          />
          <KpiTile
            label="Tracking Enabled"
            value={enabledCount}
            icon={Radar}
            tone="bg-teal-50 text-teal-800"
            loading={isLoading}
            testId="tracking-enabled"
          />
          <KpiTile
            label="Tracking Disabled"
            value={disabledCount}
            icon={UserX}
            tone="bg-gray-50 text-gray-600"
            loading={isLoading}
            testId="tracking-disabled"
          />
        </div>

        <ToolbarCard>
          <div className="relative min-w-[min(100%,14rem)] max-w-sm flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              className="h-9 pl-9 text-sm"
              placeholder="Search employees…"
              aria-label="Search employees"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <PillTabs
            size="sm"
            items={[
              { value: "all", label: "All", count: withEnabled.length },
              { value: "enabled", label: "Enabled", count: enabledCount },
              { value: "disabled", label: "Disabled", count: disabledCount },
            ]}
            value={filter}
            onChange={(v) => {
              setFilter(v as Filter);
              setPage(1);
            }}
          />
          <div className="flex items-center gap-2 sm:ml-auto">
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 text-xs"
              disabled={bulkMutation.isPending}
              onClick={() => setBulkConfirm(true)}
            >
              <Radar size={13} className="text-teal-600" />
              Enable All
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 text-xs"
              disabled={bulkMutation.isPending}
              onClick={() => setBulkConfirm(false)}
            >
              <Radar size={13} className="text-gray-400" />
              Disable All
            </Button>
          </div>
        </ToolbarCard>

        <AlertDialog
          open={bulkConfirm !== null}
          onOpenChange={(open) => {
            if (!open) setBulkConfirm(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {bulkConfirm ? "Enable live tracking for everyone?" : "Disable live tracking for everyone?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {bulkConfirm
                  ? `This turns on live location tracking for all ${withEnabled.length} active employees, not just the ones currently shown in this list.`
                  : `This turns off live location tracking for all ${withEnabled.length} active employees, not just the ones currently shown in this list.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={bulkMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={bulkMutation.isPending}
                onClick={() => handleBulkToggle(bulkConfirm === true)}
              >
                {bulkMutation.isPending ? "Updating…" : bulkConfirm ? "Enable All" : "Disable All"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="overflow-hidden rounded-2xl border bg-white" data-testid="tracking-list">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-xl" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyNote
              icon={Search}
              title="No employees match."
              hint="Try another name or code, or switch the filter back to All."
              className="m-3 border-0"
            />
          ) : (
            <>
              <div className="divide-y">
                {paged.map((emp) => (
                  <div
                    key={emp.id}
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50/70"
                    data-testid="tracking-row"
                  >
                    <PersonCell
                      className="flex-1"
                      name={`${emp.firstName} ${emp.lastName}`}
                      code={emp.employeeCode}
                      sub={`${emp.departmentName ?? "—"} · ${emp.branchName ?? "no branch"}`}
                    />
                    <span
                      className={cn(
                        "hidden text-xs font-semibold sm:inline",
                        emp.trackingEnabled ? "text-teal-700" : "text-gray-400",
                      )}
                    >
                      {emp.trackingEnabled ? "Tracking on" : "Tracking off"}
                    </span>
                    <Switch
                      checked={emp.trackingEnabled}
                      onCheckedChange={(v) => handleToggle(emp, v)}
                      disabled={toggleMutation.isPending}
                      aria-label="Toggle live location tracking"
                    />
                  </div>
                ))}
              </div>
              <div className="border-t px-4">
                <DataPagination
                  page={pageSafe}
                  totalPages={totalPages}
                  onPageChange={setPage}
                  pageSize={pageSize}
                  onPageSizeChange={setPageSize}
                  totalItems={filtered.length}
                />
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
