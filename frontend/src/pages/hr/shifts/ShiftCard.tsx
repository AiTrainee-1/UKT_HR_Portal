import type { ReactNode } from "react";
import { Clock, Factory, Pencil, Power, Trash2, UserPlus, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ShiftItem } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { durationLabel, timelineBar } from "./shift-logic";

const TYPE = {
  staff: {
    label: "Staff",
    icon: Users,
    tile: "bg-emerald-100 text-emerald-700",
    bar: "bg-emerald-500",
    edge: "bg-emerald-500",
  },
  production: {
    label: "Production",
    icon: Factory,
    tile: "bg-amber-100 text-amber-700",
    bar: "bg-amber-500",
    edge: "bg-amber-500",
  },
} as const;

function IconButton({
  label,
  onClick,
  children,
  tone = "default",
  testId,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  tone?: "default" | "danger";
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors",
        tone === "danger" ? "hover:bg-red-50 hover:text-red-600" : "hover:bg-gray-100 hover:text-gray-700",
      )}
    >
      {children}
    </button>
  );
}

/** One shift template: its hours on a 24-hour bar, the rules that matter for attendance, how many people are on it,
 *  and the few things HR does with it (assign people, edit, switch off, delete). */
export default function ShiftCard({
  shift,
  onAssign,
  onEdit,
  onToggleActive,
  onDelete,
  onViewPeople,
}: {
  shift: ShiftItem;
  onAssign: () => void;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onViewPeople: () => void;
}) {
  const t = TYPE[shift.shiftType];
  const Icon = t.icon;
  const bar = timelineBar(shift.startTime, shift.endTime);
  const length = durationLabel(shift.startTime, shift.endTime);
  const count = shift.assignedCount ?? 0;

  return (
    <Card
      className={cn(
        "overflow-hidden border-0 shadow-sm transition-shadow hover:shadow-md",
        !shift.isActive && "bg-gray-50/80",
      )}
      data-testid={`shift-card-${shift.id}`}
    >
      <div className="flex">
        <div className={cn("w-1 shrink-0", shift.isActive ? t.edge : "bg-gray-300")} />
        <div className="min-w-0 flex-1 space-y-3.5 p-4">
          <div className="flex items-start gap-3">
            <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", t.tile)}>
              <Icon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h4 className="truncate text-sm font-bold text-gray-900">{shift.name}</h4>
                {shift.isDefault && <StatusBadge tone="info">Default</StatusBadge>}
                {shift.genderRule !== "all" && (
                  <StatusBadge tone="accent" className="capitalize">
                    {shift.genderRule} only
                  </StatusBadge>
                )}
                {!shift.isActive && <StatusBadge tone="danger">Inactive</StatusBadge>}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t.label} shift</p>
            </div>
            <div className="flex shrink-0 items-center">
              <IconButton label={`Edit ${shift.name}`} onClick={onEdit} testId={`shift-edit-${shift.id}`}>
                <Pencil size={15} />
              </IconButton>
              <IconButton
                label={shift.isActive ? `Disable ${shift.name}` : `Enable ${shift.name}`}
                onClick={onToggleActive}
                testId={`shift-toggle-${shift.id}`}
              >
                <Power size={15} className={shift.isActive ? "" : "text-emerald-600"} />
              </IconButton>
              <IconButton
                label={`Delete ${shift.name}`}
                onClick={onDelete}
                tone="danger"
                testId={`shift-delete-${shift.id}`}
              >
                <Trash2 size={15} />
              </IconButton>
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <p className="flex items-center gap-1.5 text-lg font-black tabular-nums text-gray-900">
                <Clock size={15} className="text-gray-400" />
                {shift.startTime} <span className="text-gray-300">→</span> {shift.endTime}
              </p>
              {length && <span className="text-xs font-semibold text-gray-500">{length}</span>}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100" aria-hidden>
              <div
                className={cn("h-full rounded-full", shift.isActive ? t.bar : "bg-gray-300")}
                style={{ marginLeft: `${bar.left}%`, width: `${bar.width}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] font-medium text-gray-300" aria-hidden>
              <span>00</span>
              <span>06</span>
              <span>12</span>
              <span>18</span>
              <span>24</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
            <span>
              Grace <b className="text-gray-900">{shift.gracePeriodMinutes} min</b>
            </span>
            {shift.shiftType === "staff" && shift.firstHalfEnd && (
              <span>
                Lunch after <b className="text-gray-900">{shift.firstHalfEnd}</b> ({shift.lunchDurationMinutes} min)
              </span>
            )}
            {shift.departmentName && <span>{shift.departmentName}</span>}
          </div>

          <div className="flex items-center justify-between gap-2 border-t pt-3">
            <button
              type="button"
              onClick={onViewPeople}
              disabled={count === 0}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-600 transition-colors enabled:hover:text-primary disabled:text-gray-400"
              data-testid={`shift-people-${shift.id}`}
            >
              <Users size={13} />
              {count === 0 ? "Nobody on it yet" : `${count} employee${count === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              onClick={onAssign}
              disabled={!shift.isActive}
              title={shift.isActive ? "Choose who works this shift" : "Enable the shift before assigning people to it"}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid={`shift-assign-${shift.id}`}
            >
              <UserPlus size={13} /> Assign people
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}
