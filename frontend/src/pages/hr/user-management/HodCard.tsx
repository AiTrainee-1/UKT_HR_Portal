import type { ReactNode } from "react";
import { Building2, ChevronRight, Trash2, TriangleAlert, UserMinus, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import type { DepartmentManagerItem } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { disabledPermissions, enabledPermissions, permissionValuesOf } from "./approval-permissions";

function Stat({
  icon,
  children,
  title,
  className,
}: {
  icon: ReactNode;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-gray-600", className)} title={title}>
      {icon}
      {children}
    </span>
  );
}

/** One Department Head in the HOD list: who they are, how many departments and people they cover, what they may
 *  approve, and the few things HR does from the list (open, enable/disable, remove). */
export default function HodCard({
  manager: m,
  onOpen,
  onToggleActive,
  onDelete,
  busy,
}: {
  manager: DepartmentManagerItem;
  onOpen: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const values = permissionValuesOf(m);
  const on = enabledPermissions(values);
  const off = disabledPermissions(values);
  const subtitle = [m.designation, m.department].filter(Boolean).join(" · ");

  return (
    <Card
      className={cn(
        "group cursor-pointer overflow-hidden border-0 shadow-sm transition-shadow hover:shadow-md",
        !m.isActive && "bg-gray-50/80",
      )}
      onClick={onOpen}
      data-testid={`hod-card-${m.id}`}
    >
      <div className="flex">
        <div
          className={cn("w-1 shrink-0", m.isActive ? "bg-gradient-to-b from-blue-500 to-indigo-500" : "bg-gray-300")}
        />
        <div className="min-w-0 flex-1 space-y-3 p-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-black text-white",
                m.isActive ? "bg-gradient-to-br from-blue-500 to-indigo-600" : "bg-gray-300",
              )}
            >
              {m.employeeName.charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={cn("truncate text-sm font-bold", m.isActive ? "text-gray-900" : "text-gray-500")}>
                  {m.employeeName}
                </span>
                <code className="rounded border bg-gray-50 px-1.5 py-0.5 font-mono text-[11px] text-gray-600">
                  {m.employeeCode}
                </code>
                {!m.isActive && <StatusBadge tone="danger">Inactive</StatusBadge>}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {subtitle || "No designation or department"}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1 sm:gap-2" onClick={(e) => e.stopPropagation()}>
              <label className="hidden items-center gap-2 text-xs font-medium text-gray-500 sm:flex">
                {m.isActive ? "Active" : "Inactive"}
                <Switch
                  checked={m.isActive}
                  onCheckedChange={onToggleActive}
                  disabled={busy}
                  aria-label={m.isActive ? "Disable this department user" : "Enable this department user"}
                  data-testid={`hod-active-${m.id}`}
                />
              </label>
              <button
                type="button"
                onClick={onDelete}
                aria-label={`Remove ${m.employeeName} as a department user`}
                title="Remove department user"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                data-testid={`hod-delete-${m.id}`}
              >
                <Trash2 size={15} />
              </button>
              <ChevronRight
                size={16}
                className="text-gray-300 transition-transform group-hover:translate-x-0.5 group-hover:text-gray-500"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-3">
            <Stat icon={<Building2 size={13} className="text-indigo-500" />}>
              <b className="text-gray-900">{m.departmentCount}</b> department{m.departmentCount === 1 ? "" : "s"}
            </Stat>
            <Stat
              icon={<Users size={13} className="text-blue-500" />}
              title="Employees who report to this HOD, individually or through a department"
            >
              <b className="text-gray-900">{m.employeeCount}</b> reporting
            </Stat>
            {(m.removedCount ?? 0) > 0 && (
              <Stat
                icon={<UserMinus size={13} className="text-gray-400" />}
                title="Employees taken out of this HOD's departments. They stay in the department but report elsewhere."
              >
                <b className="text-gray-900">{m.removedCount}</b> removed
              </Stat>
            )}
            {(m.overlapCount ?? 0) > 0 && (
              <Stat
                icon={<TriangleAlert size={13} className="text-amber-500" />}
                className="text-amber-700"
                title="Employees listed here who already report to a different HOD. Open the HOD to see them."
              >
                <b>{m.overlapCount}</b> with another HOD
              </Stat>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5" data-testid={`hod-perms-${m.id}`}>
            {on.length === 0 ? (
              <span className="text-xs font-medium text-amber-700">Cannot approve any request</span>
            ) : (
              on.map((p) => (
                <span
                  key={p.key}
                  className="inline-flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700"
                >
                  <p.icon size={11} />
                  {p.short}
                </span>
              ))
            )}
            {off.length > 0 && on.length > 0 && (
              <span
                className="rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-500"
                title={`Switched off: ${off.map((p) => p.short).join(", ")}`}
              >
                {off.length} off
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
