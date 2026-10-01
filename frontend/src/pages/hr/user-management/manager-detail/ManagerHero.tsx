import type { ReactNode } from "react";
import { Building2, TriangleAlert, UserMinus, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import type { DepartmentManagerItem } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";

function Tile({
  icon,
  tint,
  value,
  label,
  hint,
  testId,
}: {
  icon: ReactNode;
  tint: string;
  value: number;
  label: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-gray-50/80 p-3" title={hint} data-testid={testId}>
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", tint)}>{icon}</span>
      <div className="min-w-0">
        <p className="text-xl font-black leading-none text-gray-900">{value}</p>
        <p className="mt-1 truncate text-[11px] font-medium text-gray-500">{label}</p>
      </div>
    </div>
  );
}

/** Who the Department Head is, whether they are active, and how many people they really cover. */
export default function ManagerHero({
  manager,
  onToggleActive,
  saving,
}: {
  manager: DepartmentManagerItem;
  onToggleActive: () => void;
  saving: boolean;
}) {
  const subtitle = [manager.designation, manager.department].filter(Boolean).join(" · ");
  return (
    <Card className="overflow-hidden border-0 shadow-sm" data-testid="manager-hero">
      <div className="h-1.5 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500" />
      <div className="space-y-5 p-4 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <div
              className={cn(
                "flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-xl font-black text-white shadow-sm",
                manager.isActive ? "bg-gradient-to-br from-blue-500 to-indigo-600" : "bg-gray-300",
              )}
            >
              {manager.employeeName.charAt(0)}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <h2 className="truncate text-xl font-black text-gray-900 sm:text-2xl">{manager.employeeName}</h2>
                <code className="rounded border bg-gray-50 px-1.5 py-0.5 font-mono text-xs text-gray-600">
                  {manager.employeeCode}
                </code>
                <StatusBadge tone={manager.isActive ? "success" : "danger"}>
                  {manager.isActive ? "Active" : "Inactive"}
                </StatusBadge>
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {subtitle || "No designation or department"}
              </p>
            </div>
          </div>

          <label className="flex shrink-0 items-center gap-3 rounded-xl border bg-white px-3.5 py-2.5 text-sm">
            <span className="min-w-0">
              <span className="block font-semibold text-gray-900">
                {manager.isActive ? "Can approve requests" : "Approvals paused"}
              </span>
              <span className="block text-xs text-muted-foreground">
                {manager.isActive ? "Switch off to pause" : "Switch on to resume"}
              </span>
            </span>
            <Switch
              checked={manager.isActive}
              onCheckedChange={onToggleActive}
              disabled={saving}
              aria-label={manager.isActive ? "Disable this department user" : "Enable this department user"}
              data-testid="manager-active-switch"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Tile
            testId="tile-departments"
            icon={<Building2 size={17} />}
            tint="bg-indigo-100 text-indigo-600"
            value={manager.departmentCount}
            label="Departments"
          />
          <Tile
            testId="tile-reporting"
            icon={<Users size={17} />}
            tint="bg-blue-100 text-blue-600"
            value={manager.employeeCount}
            label="Reporting to this HOD"
            hint="Employees who report to this HOD, individually or through a department"
          />
          <Tile
            testId="tile-removed"
            icon={<UserMinus size={17} />}
            tint="bg-gray-200 text-gray-500"
            value={manager.removedCount ?? 0}
            label="Removed from departments"
            hint="Taken out of this HOD's departments. They stay in the department but report elsewhere."
          />
          <Tile
            testId="tile-elsewhere"
            icon={<TriangleAlert size={17} />}
            tint="bg-amber-100 text-amber-600"
            value={manager.overlapCount ?? 0}
            label="With another HOD"
            hint="Listed here, but they already report to a different HOD"
          />
        </div>

        {manager.notes && (
          <p className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="font-bold">Note:</span> {manager.notes}
          </p>
        )}
      </div>
    </Card>
  );
}
